"""What an MCP agent sees: instructions, schemas, excerpts, warnings and hints."""

import asyncio
import base64

from mcp import Client

from symbiknow.search.projection import _excerpt, project_search
from symbiknow.cli.client import server_parameters

ROWS = "".join(f"Row {i}: the Orion telemetry value is {i * 7}.\n" for i in range(12300, 12360))


def b64(text):
    return base64.b64encode(text.encode()).decode()


def test_excerpt_centres_on_rare_query_terms():
    excerpt, offset = _excerpt(ROWS, "What is the Orion telemetry value for Row 12345?")
    assert "Row 12345: the Orion telemetry value is 86415." in excerpt
    assert ROWS[offset:].startswith(excerpt)


def test_excerpt_numbers_match_whole_and_unmatched_text_keeps_its_head():
    text = "Row 123456 is wrong. " * 40 + "Row 12345 is right. " + "padding " * 60
    assert "12345 is right" in _excerpt(text, "Row 12345")[0]
    assert _excerpt("intro " * 100, "nothing relevant") == (("intro " * 100)[:384], 0)


def test_excerpt_handles_hebrew_queries():
    text = "בדיקה " * 100 + "תאריך ההשקה של פלקון הוא 14 במרץ 2027. " + "מילוי " * 100
    assert "14 במרץ 2027" in _excerpt(text, "מתי תאריך ההשקה של פלקון?")[0]


def test_compact_answer_shows_the_supported_value():
    match = {
        "document_id": "d",
        "version": "v1",
        "evidence": [{"evidence_id": "d:v1:t0", "text": ROWS, "basis": "text"}],
        "jev": {
            "status": "evaluated",
            "supporting_chunk_ids": ["d:v1:t0"],
            "evaluated_evidence": [
                {"chunk_id": "d:v1:t0", "text": ROWS[100:], "text_start": 100}
            ],
        },
    }
    query = "Orion telemetry value for Row 12345"
    row = project_search({"matches": [match]}, query=query)["matches"][0]["evidence"][0]
    assert "86415" in row["text"] and row["excerpt_truncated"]
    assert ROWS[row["text_start"] :].startswith(row["text"])
    # Without a query, projection keeps its previous head-of-window behaviour.
    assert "86415" not in project_search({"matches": [match]})["matches"][0]["evidence"][0]["text"]


def test_agent_facing_contract(tmp_path):
    async def exercise():
        async with Client(server_parameters(str(tmp_path), storage_only=True)) as client:
            assert "search first" in client.instructions.casefold()
            tools = {tool.name: tool for tool in (await client.list_tools()).tools}
            for name in (
                "scan_freshness", "get_freshness_scan", "cancel_freshness_scan",
                "review_freshness_finding",
            ):
                assert name not in tools
                assert name not in client.instructions
                response = await client.call_tool(name, {})
                assert response.is_error
                assert name in response.content[0].text
            upload_item = tools["upload"].input_schema["properties"]["files"]["items"]
            if "$ref" in upload_item:
                upload_item = tools["upload"].input_schema["$defs"][upload_item["$ref"].split("/")[-1]]
            assert set(upload_item["required"]) == {"filename", "content_base64"}
            assert "expected_version" in upload_item["properties"]
            mode = tools["search"].input_schema["properties"]["mode"]
            assert set(mode["enum"]) == {"hybrid", "keyword", "semantic", "answer", "grep"}

            async def upload(*items):
                from symbiknow.cli.client import call
                response = await call(client, "upload", {"files": list(items)})
                return response["files"]

            first = (await upload({"filename": "plan.md", "content_base64": b64("one")}))[0]
            second = (await upload({"filename": "plan.md", "content_base64": b64("two")}))[0]
            assert second["document_id"] != first["document_id"]
            assert second["warnings"][0]["code"] == "possible_duplicate"
            assert second["warnings"][0]["document_id"] == first["document_id"]
            update = {
                "filename": "plan.md",
                "content_base64": b64("three"),
                "document_id": first["document_id"],
            }
            updated = (await upload(dict(update, expected_version="v1")))[0]
            assert updated["version"] == "v2" and "warnings" not in updated

            stale, bad_id, bad_bytes = await upload(
                dict(update, content_base64=b64("four"), expected_version="v1"),
                {"filename": "x.txt", "content_base64": b64("x"), "request_id": "my-upload"},
                {"filename": "x.txt", "content_base64": "not base64!"},
            )
            assert stale["index"] == 0 and stale["current_version"] == "v2"
            assert stale["document_id"] == first["document_id"]
            assert "Expected v1, found v2" in stale["error"] and "'v2'" in stale["hint"]
            assert bad_id["index"] == 1 and "must be a UUID" in bad_id["error"]
            assert "not valid base64" in bad_bytes["error"]

            missing = await client.call_tool(
                "download", {"files": [{"document_id": "missing"}, {"document_id": first["document_id"], "version": "v9"}]}
            )
            gone, no_version = missing.structured_content["files"]
            assert "deleted or never uploaded" in gone["error"]
            assert "has no version 'v9'" in no_version["error"]

            invalid = await client.call_tool("upload", {"files": [{"filename": "x.txt"}]})
            assert invalid.is_error and "content_base64" in invalid.content[0].text

            from symbiknow.cli.client import call
            result = await call(client, "search", {"query": "plan", "folder": "Projects"})
            assert any("No folder named 'Projects'" in hint for hint in result["hints"])
            assert not any(k.endswith("_seconds") for k in result["metrics"])

    asyncio.run(exercise())
