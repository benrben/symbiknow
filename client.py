"""File and folder transfers through the official MCP SDK (HTTP or stdio)."""

from __future__ import annotations

import argparse
import asyncio
import base64
import hashlib
import json
import os
from pathlib import Path
import sys
import uuid

from mcp import Client, StdioServerParameters

CHUNK_BYTES = 256 * 1024


def server_parameters(
    data_dir: str | None = None, storage_only: bool = False
) -> StdioServerParameters:
    env = dict(os.environ)
    if data_dir:
        env["SYMBIKNOW_DATA_DIR"] = str(Path(data_dir).resolve())
    if storage_only:
        env["SYMBIKNOW_STORAGE_ONLY"] = "1"
    return StdioServerParameters(
        command=sys.executable,
        args=["-m", "app.server"],
        cwd=Path(__file__).resolve().parent,
        env=env,
    )


async def call(session, name: str, arguments: dict, retries: int = 2) -> dict:
    """Retry transport failures only; callers retain IDs and version pins across attempts."""
    for attempt in range(retries + 1):
        try:
            response = await session.call_tool(name, arguments)
            if response.is_error:
                raise ValueError(
                    "; ".join(getattr(block, "text", "") for block in response.content)
                )
            value = response.structured_content
            if not isinstance(value, dict):
                raise ValueError("MCP server did not return structured content")
            return value
        except (OSError, TimeoutError):
            if attempt == retries:
                raise
            await asyncio.sleep(0.25 * (attempt + 1))
    raise RuntimeError("Unreachable")


async def upload_files(
    session,
    paths: list[str | Path],
    *,
    document_id: str | None = None,
    expected_version: str | None = None,
    request_ids: list[str] | None = None,
    chunk_bytes: int = CHUNK_BYTES,
) -> list[dict]:
    if document_id and len(paths) != 1:
        raise ValueError("Updates require one file per invocation")
    if not 1 <= chunk_bytes <= CHUNK_BYTES:
        raise ValueError("chunk_bytes must be between 1 and 256KiB")
    request_ids = request_ids or [str(uuid.uuid4()) for _ in paths]
    if len(request_ids) != len(paths):
        raise ValueError("Supply one request_id per file")
    results = []
    small = []
    import mimetypes

    for raw_path, request_id in zip(paths, request_ids):
        path = Path(raw_path).resolve()
        size = path.stat().st_size
        item = {
            "filename": path.name,
            "source": str(path),
            "mime_type": mimetypes.guess_type(path.name)[0] or "application/octet-stream",
            "request_id": request_id,
        }
        if document_id:
            item["document_id"] = document_id
        if expected_version:
            item["expected_version"] = expected_version
        if size <= chunk_bytes:
            small.append(
                dict(item, content_base64=base64.b64encode(path.read_bytes()).decode("ascii"))
            )
            if (
                len(small) == 2
            ):  # Keep bulk response/request payloads below a typical 1MiB host limit.
                response = await call(session, "upload", {"files": small})
                results.extend(response["files"])
                small = []
            continue
        with path.open("rb") as hash_input:
            digest = hashlib.file_digest(hash_input, "sha256").hexdigest()
        offset = 0
        with path.open("rb") as handle:
            while chunk := handle.read(chunk_bytes):
                response = await call(
                    session,
                    "upload",
                    {
                        "files": [
                            dict(
                                item,
                                content_base64=base64.b64encode(chunk).decode("ascii"),
                                offset=offset,
                                total_size=size,
                                sha256=digest,
                                final=offset + len(chunk) == size,
                            )
                        ]
                    },
                )
                result = response["files"][0]
                if result.get("error"):
                    raise ValueError(result["error"])
                offset += len(chunk)
        results.append(result)
    if small:
        response = await call(session, "upload", {"files": small})
        results.extend(response["files"])
    for result in results:
        if result.get("error"):
            raise ValueError(result["error"])
    by_request = {result["request_id"]: result for result in results}
    return [by_request[request_id] for request_id in request_ids]


async def download_files(
    session, requests: list[dict], output_dir: str | Path, *, chunk_bytes: int = CHUNK_BYTES
) -> list[dict]:
    if not 1 <= chunk_bytes <= CHUNK_BYTES:
        raise ValueError("chunk_bytes must be between 1 and 256KiB")
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    downloaded = []
    for request in requests:
        offset = 0
        version = request.get("version")
        temporary = output_dir / f".symbiknow-{uuid.uuid4()}.part"
        digest = hashlib.sha256()
        try:
            with temporary.open("wb") as handle:
                while True:
                    response = await call(
                        session,
                        "download",
                        {
                            "files": [
                                dict(request, version=version, offset=offset, length=chunk_bytes)
                            ]
                        },
                    )
                    result = response["files"][0]
                    if result.get("error"):
                        raise ValueError(result["error"])
                    if version is None:
                        version = result["version"]
                    if result["version"] != version or result["offset"] != offset:
                        raise ValueError("Download version/offset changed during transfer")
                    chunk = base64.b64decode(result["content_base64"], validate=True)
                    if len(chunk) != result["returned_bytes"] or (not chunk and not result["eof"]):
                        raise ValueError("Invalid download chunk")
                    handle.write(chunk)
                    digest.update(chunk)
                    offset += len(chunk)
                    if result["eof"]:
                        break
            if digest.hexdigest() != result["sha256"] or offset != result["size"]:
                raise ValueError("Download failed whole-file integrity verification")
            # Document/version prefix avoids collisions between original filenames and versions.
            name = Path(result["filename"]).name
            destination = output_dir / f"{result['document_id']}-{version}-{name}"
            if destination.exists():
                raise FileExistsError(f"Refusing to overwrite {destination}")
            temporary.replace(destination)
            downloaded.append(dict(result, output_path=str(destination)))
        finally:
            temporary.unlink(missing_ok=True)
    return downloaded


async def upload_folder(
    session, directory, folder, request_id, *, updates=None, chunk_bytes=CHUNK_BYTES
):
    """Send regular files recursively; callers retain the folder UUID for retries."""
    from app.folder_transfer import relative_parts

    if not 1 <= chunk_bytes <= CHUNK_BYTES:
        raise ValueError("chunk_bytes must be between 1 and 256KiB")
    directory = Path(directory).resolve()
    if not directory.is_dir():
        raise ValueError("Upload source must be a directory")
    paths = sorted(directory.rglob("*"))
    if any(path.is_symlink() for path in paths):
        raise ValueError("Folder upload does not follow symbolic links")
    paths = [path for path in paths if path.is_file()]
    if not paths:
        raise ValueError("Folder contains no regular files; empty directories are not stored")
    for path in paths:
        relative_parts(path.relative_to(directory).as_posix())
    results = []
    for path in paths:
        relative = path.relative_to(directory).as_posix()
        common = {
            "relative_path": relative,
            "source": str(path),
            **(updates or {}).get(relative, {}),
        }
        size = path.stat().st_size
        if size <= chunk_bytes:
            response = await call(
                session,
                "upload_folder",
                {
                    "folder": folder,
                    "request_id": request_id,
                    "files": [
                        {
                            **common,
                            "content_base64": base64.b64encode(path.read_bytes()).decode("ascii"),
                        }
                    ],
                },
            )
        else:
            with path.open("rb") as handle:
                digest = hashlib.file_digest(handle, "sha256").hexdigest()
            offset = 0
            with path.open("rb") as handle:
                while chunk := handle.read(chunk_bytes):
                    response = await call(
                        session,
                        "upload_folder",
                        {
                            "folder": folder,
                            "request_id": request_id,
                            "files": [
                                {
                                    **common,
                                    "content_base64": base64.b64encode(chunk).decode("ascii"),
                                    "offset": offset,
                                    "total_size": size,
                                    "sha256": digest,
                                    "final": offset + len(chunk) == size,
                                }
                            ],
                        },
                    )
                    if response["files"][0].get("error"):
                        raise ValueError(response["files"][0]["error"])
                    offset += len(chunk)
        result = response["files"][0]
        if result.get("error") or not result.get("folder_assigned"):
            raise ValueError(result.get("error", "Folder assignment did not complete"))
        results.append(result)
    return {"request_id": request_id, "folder": folder, "files": results}


async def download_folder(session, folder, output_path, *, chunk_bytes=CHUNK_BYTES):
    """Save a version-pinned folder ZIP, verifying its bytes without extracting it."""
    if not 1 <= chunk_bytes <= CHUNK_BYTES:
        raise ValueError("chunk_bytes must be between 1 and 256KiB")
    output_path = Path(output_path)
    if output_path.exists():
        raise FileExistsError(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = output_path.parent / f".symbiknow-folder-{uuid.uuid4()}.part"
    offset = 0
    transfer_id = None
    digest = hashlib.sha256()
    identity = None
    try:
        with temporary.open("xb") as handle:
            while True:
                result = await call(
                    session,
                    "download_folder",
                    {
                        "folder": folder,
                        "transfer_id": transfer_id,
                        "offset": offset,
                        "length": chunk_bytes,
                    },
                )
                current = (result["transfer_id"], result["size"], result["sha256"])
                if identity is None:
                    identity = current
                if current != identity or result["offset"] != offset:
                    raise ValueError("Folder download snapshot changed")
                transfer_id = result["transfer_id"]
                chunk = base64.b64decode(result["content_base64"], validate=True)
                if len(chunk) != result["returned_bytes"] or (not chunk and not result["eof"]):
                    raise ValueError("Invalid folder download chunk")
                handle.write(chunk)
                digest.update(chunk)
                offset += len(chunk)
                if result["eof"]:
                    break
        if offset != result["size"] or digest.hexdigest() != result["sha256"]:
            raise ValueError("Folder ZIP failed integrity verification")
        # Atomic no-overwrite publication, including a concurrent destination creation.
        os.link(temporary, output_path)
        return {k: v for k, v in result.items() if k != "content_base64"} | {
            "output_path": str(output_path)
        }
    finally:
        temporary.unlink(missing_ok=True)


async def _main(args) -> None:
    async with Client(args.url or server_parameters(args.data_dir, args.storage_only)) as session:
        if args.command == "upload-folder":
            result = await upload_folder(session, args.directory, args.folder, args.request_id)
        elif args.command == "download-folder":
            result = await download_folder(session, args.folder, args.output)
        elif args.command == "upload":
            result = await upload_files(
                session,
                args.files,
                document_id=args.document_id,
                expected_version=args.expected_version,
                request_ids=args.request_id,
            )
        elif args.command == "download":
            result = await download_files(
                session,
                [{"document_id": item, "version": args.version} for item in args.document_ids],
                args.output_dir,
            )
            result = [
                {key: value for key, value in item.items() if key != "content_base64"}
                for item in result
            ]
        else:
            result = await call(
                session,
                "search",
                {"query": args.query, "mode": args.mode, "evaluate": args.evaluate},
            )
        print(json.dumps(result, indent=2))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", help="Running HTTP MCP endpoint; avoids a second library owner")
    parser.add_argument("--data-dir")
    parser.add_argument("--storage-only", action="store_true")
    commands = parser.add_subparsers(dest="command", required=True)
    folder_upload = commands.add_parser("upload-folder")
    folder_upload.add_argument("directory")
    folder_upload.add_argument("--folder", required=True)
    folder_upload.add_argument(
        "--request-id", required=True, help="UUID reused across retries of this folder upload"
    )
    folder_download = commands.add_parser("download-folder")
    folder_download.add_argument("folder")
    folder_download.add_argument("--output", required=True, help="New ZIP output path")
    upload = commands.add_parser("upload")
    upload.add_argument("files", nargs="+")
    upload.add_argument("--document-id")
    upload.add_argument("--expected-version")
    upload.add_argument(
        "--request-id", action="append", help="Stable retry UUID; repeat once per input file"
    )
    download = commands.add_parser("download")
    download.add_argument("document_ids", nargs="+")
    download.add_argument("--version")
    download.add_argument("--output-dir", default="downloads")
    search = commands.add_parser("search")
    search.add_argument("query")
    search.add_argument(
        "--mode", choices=["semantic", "keyword", "hybrid", "answer"], default="hybrid"
    )
    search.add_argument("--evaluate", action="store_true")
    asyncio.run(_main(parser.parse_args()))


if __name__ == "__main__":
    main()
