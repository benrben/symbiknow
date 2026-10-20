"""Best-effort local v23 observations. The caller always returns the primary Jev response."""

from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import queue
import threading
import urllib.request
from urllib.parse import urlsplit


def _snapshot(response):
    return {'model': response.model,
            'answers': {k: v.model_dump(mode='json') for k, v in response.answers.items()}}


def _validate(payload, response, model):
    if response.get('model') != model:
        raise ValueError('Unexpected shadow model')
    answers = response.get('answers', {})
    if set(answers) != set(payload['questions']):
        raise ValueError('Incomplete shadow response')
    for key, question in payload['questions'].items():
        answer = answers[key]
        if answer.get('type') != question['type']:
            raise ValueError('Wrong answer type')
        if question['type'] == 'choice':
            probs = answer.get('probabilities', {})
            if set(probs) != set(question['criteria']) or answer.get('choice') not in probs:
                raise ValueError('Invalid shadow options')
            values = [*probs.values(), answer.get('confidence')]
            if abs(sum(probs.values()) - 1) > .001:
                raise ValueError('Invalid shadow distribution')
        else:
            values = [answer.get('noul')]
        if any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v)
               or not 0 <= v <= 1 for v in values):
            raise ValueError('Invalid shadow probability')


class ShadowRecorder:
    def __init__(self, url, model, log_path, *, capacity=8, timeout=15, transport=None):
        parsed = urlsplit(url)
        if (parsed.scheme != 'http' or parsed.hostname not in {'localhost', '127.0.0.1', '::1'}
                or parsed.username or parsed.password or parsed.query or parsed.fragment
                or parsed.path not in {'', '/'}):
            raise ValueError('Shadow endpoint must be a local HTTP server origin')
        self.url, self.model, self.log_path = url.rstrip('/'), model, Path(log_path)
        self.timeout, self.transport = timeout, transport or self._send
        self.pending = queue.Queue(maxsize=capacity)
        self.dropped = 0
        self.completed = 0
        self.failures = 0
        self._thread = threading.Thread(target=self._worker, daemon=True, name='jev-v23-shadow')
        self._thread.start()

    def _send(self, payload):
        # No primary API key, SDK headers, or proxy environment is forwarded.
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(self.url + '/health', timeout=self.timeout) as r:
            health = json.load(r)
        if health.get('status') != 'ok' or health.get('model') != self.model or health.get('max_length') != 4096:
            raise ValueError('Wrong shadow checkpoint/window')
        request = urllib.request.Request(self.url + '/v1/systemone', data=payload,
                                         headers={'Content-Type': 'application/json'})
        with opener.open(request, timeout=self.timeout) as r:
            return json.load(r)

    def submit(self, state, questions, primary):
        # Own an immutable copy before the app mutates/reuses its request objects.
        payload = json.dumps({'state': state, 'questions': {k: q.model_dump(mode='json') for k,q in questions.items()},
                              'model': self.model}, ensure_ascii=False).encode()
        if len(payload) > 512 * 1024:
            self.dropped += 1
            return False
        item = (payload, _snapshot(primary))
        try:
            self.pending.put_nowait(item)
            return True
        except queue.Full:
            self.dropped += 1
            return False

    def _worker(self):
        while True:
            payload, primary = self.pending.get()
            try:
                task = json.loads(payload)
                event = {'utc': datetime.now(timezone.utc).isoformat(),
                         'request_sha256': hashlib.sha256(payload).hexdigest(),
                         'mode': 'observe_only', 'primary': primary}
                try:
                    candidate = self.transport(payload)
                    _validate(task, candidate, self.model)
                    event.update(status='evaluated', shadow=candidate,
                                 disagreements=[k for k,q in task['questions'].items()
                                     if self._decision(primary['answers'][k],q) != self._decision(candidate['answers'][k],q)])
                    self.completed += 1
                except Exception as error:
                    event.update(status='shadow_failed', error_type=type(error).__name__)
                    self.failures += 1
                # Evidence, question text, credentials and raw HTTP objects are never logged.
                self.log_path.parent.mkdir(parents=True, exist_ok=True)
                if not self.log_path.exists() or self.log_path.stat().st_size < 10 * 1024 * 1024:
                    with self.log_path.open('a', encoding='utf-8') as f:
                        f.write(json.dumps(event, ensure_ascii=False) + '\n')
            except Exception:
                self.failures += 1
            finally:
                self.pending.task_done()

    @staticmethod
    def _decision(answer, question):
        return answer['choice'] if question['type'] == 'choice' else answer['noul'] >= .5


_recorder = None
_lock = threading.Lock()


def record_shadow(state, questions, response):
    """Called after successful Jev calls. Never waits for inference or changes the response."""
    global _recorder
    if os.getenv('SYMBIKNOW_V23_SHADOW', '') != '1' or not any(k.startswith('judge_') for k in questions):
        return
    try:
        with _lock:
            if _recorder is None:
                _recorder = ShadowRecorder(os.environ['SYMBIKNOW_V23_SHADOW_URL'],
                    os.environ['SYMBIKNOW_V23_SHADOW_MODEL'], os.environ['SYMBIKNOW_V23_SHADOW_LOG'])
            recorder = _recorder
        recorder.submit(state, questions, response)
    except Exception:
        # Logging, serialization, configuration, and shadow outages cannot break Jev.
        return
