"""Provider context recovery keeps all proof evidence and all required questions."""
import copy
import json

import httpx2
import pytest
from typesafe_sdk import Choice, Noul, RetryPolicy, TypeSafeBadRequestError, TypeSafeClient

from symbiknow.ai import jev


def client(respond):
    return TypeSafeClient(api_key="fixture", model="jev-test", transport=httpx2.MockTransport(respond),
                          retry=RetryPolicy(max_retries=0))


def rejected(kind="max_tokens_exceeded"):
    return httpx2.Response(400, json={"detail": {"error_type": kind, "message": "private source"}})


def answered(body, *, model="jev-test", omit=None):
    answers = {}
    for key, q in body["questions"].items():
        if key == omit:
            continue
        if q["type"] == "choice":
            selected = next(iter(q["criteria"]))
            answers[key] = dict(type="choice", choice=selected, confidence=.95,
                                probabilities={name: float(name == selected) for name in q["criteria"]})
        else:
            answers[key] = dict(type="noul", noul=.95)
    return httpx2.Response(200, json=dict(model=model, answers=answers,
                                         usage=dict(input_tokens=100, output_tokens=len(answers))))


def test_provider_recovers_oversized_question_batches_without_trimming_state():
    state = {"documents": [{"text": "Original claim. This is a rejected proposal, not adopted policy.",
                             "chunk_id": "source:v3:t1", "version": "v3"}]}
    questions = {f"q{i}": Choice(instructions="Check the original claim and all its qualifiers.",
                               criteria={"yes": "The exact qualified claim", "no": "Not established"})
                 if i % 2 else Noul(instructions="Is the exact claim established?") for i in range(9)}
    before = copy.deepcopy(state)
    calls, completed = [], []

    def respond(request):
        body = json.loads(request.content)
        calls.append(body)
        if len(body["questions"]) > 2:
            return rejected()
        completed.extend(body["questions"])
        return answered(body)

    with client(respond) as sdk:
        result = jev._call(state, questions, sdk)
    assert set(result.answers) == set(questions)
    assert len(completed) == len(set(completed)) == len(questions)
    assert all(call["state"] == before for call in calls)
    assert state == before
    assert set(result.nouls) == {"q0", "q2", "q4", "q6", "q8"}
    assert set(result.choices) == {"q1", "q3", "q5", "q7"}
    assert result.usage.output_tokens == 9
    assert result.usage.input_tokens == 100 * sum(len(call["questions"]) <= 2 for call in calls)


def test_learned_context_limit_splits_before_sending_on_the_same_client_only():
    calls = []

    def respond(request):
        body = json.loads(request.content)
        calls.append(len(body["questions"]))
        return rejected() if len(body["questions"]) > 2 else answered(body)

    questions = {f"q{i}": Noul(instructions="Is the exact claim established?") for i in range(8)}
    with client(respond) as sdk:
        jev._call({"text": "source"}, questions, sdk)
        assert calls[0] == 8 and 4 in calls
        calls.clear()
        # The same client already saw a batch this large rejected: no failed trip.
        result = jev._call({"text": "source"}, questions, sdk)
    assert set(result.answers) == set(questions)
    assert calls == [2, 2, 2, 2]
    calls.clear()
    with client(respond) as other:
        jev._call({"text": "source"}, questions, other)
    assert calls[0] == 8  # Another client has not learned that limit.


def test_single_question_context_failure_remains_explicit_and_sanitized():
    calls = []
    def respond(request):
        calls.append(request)
        return rejected()
    with client(respond) as sdk, pytest.raises(jev.ContextBudgetError) as error:
        jev._call({"text": "Unabridged source"}, {"q": Noul(instructions="Check it")}, sdk)
    assert len(calls) == 1
    assert "private" not in str(error.value)


def test_other_bad_requests_are_not_retried_as_context_errors():
    calls = []
    def respond(request):
        calls.append(request)
        return rejected("invalid_model")
    with client(respond) as sdk, pytest.raises(TypeSafeBadRequestError):
        jev._call({"text": "source"}, {str(i): Noul(instructions="Check it") for i in range(4)}, sdk)
    assert len(calls) == 1


@pytest.mark.parametrize("failure", ["missing_answer", "changed_model", "later_outage"])
def test_partial_batches_never_return_a_complete_decision(failure):
    def respond(request):
        body = json.loads(request.content)
        if len(body["questions"]) > 1:
            return rejected()
        if "second" in body["questions"]:
            if failure == "later_outage":
                return httpx2.Response(503, json={"detail": "unavailable"})
            return answered(body, model="different" if failure == "changed_model" else "jev-test",
                            omit="second" if failure == "missing_answer" else None)
        return answered(body)
    with client(respond) as sdk, pytest.raises(Exception):
        jev._call({"text": "source"}, {name: Noul(instructions="Check it") for name in ["first", "second"]}, sdk)


def test_question_splitting_has_a_hard_attempt_bound():
    calls = 0
    def respond(request):
        nonlocal calls
        calls += 1
        body = json.loads(request.content)
        return rejected() if len(body["questions"]) > 1 else answered(body)
    with client(respond) as sdk, pytest.raises(jev.ContextBudgetError, match="batching limit"):
        jev._call({"text": "source"}, {str(i): Noul(instructions="Check it") for i in range(100)}, sdk)
    assert calls == 64
