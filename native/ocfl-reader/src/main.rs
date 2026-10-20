//! Bounded, read-only metadata access through the same pinned library as rocfl cat.
//! The parent owns cross-process storage locking, request serialization and deadlines.

use rocfl::ocfl::{LogicalPath, OcflRepo, RocflError, VersionRef};
use serde::Deserialize;
use serde_json::{json, Value};
use std::io::{self, BufRead, Read, Write};

const VERSION: &str = "symbiknow-ocfl-reader 2 (rocfl 1.7.0)";
const MAX_REQUEST: usize = 1024 * 1024;
const MAX_RESPONSE: usize = 16 * 1024 * 1024;
const MAX_REFERENCES: usize = 800;
const STREAM_CHUNK: usize = 64 * 1024;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Batch {
    requests: Vec<Reference>,
    #[serde(default)]
    stream: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Reference {
    document_id: String,
    version: Option<String>,
}

struct Failure {
    kind: &'static str,
    message: String,
}

impl Failure {
    fn new(kind: &'static str, message: impl ToString) -> Self {
        Self { kind, message: message.to_string() }
    }
}

struct BoundedBytes {
    bytes: Vec<u8>,
    limit: usize,
    overflowed: bool,
}

impl Write for BoundedBytes {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() > self.limit.saturating_sub(self.bytes.len()) {
            self.overflowed = true;
            return Err(io::Error::new(io::ErrorKind::InvalidData, "metadata response budget exceeded"));
        }
        self.bytes.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> { Ok(()) }
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 128 && id.as_bytes()[0].is_ascii_alphanumeric()
        && id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
}

fn valid_version(version: &str) -> bool {
    let bytes = version.as_bytes();
    bytes.len() >= 2 && bytes[0] == b'v' && (b'1'..=b'9').contains(&bytes[1])
        && bytes[2..].iter().all(u8::is_ascii_digit)
}

fn parse_batch(line: &[u8]) -> Result<Batch, Failure> {
    let batch: Batch = serde_json::from_slice(line)
        .map_err(|e| Failure::new("request", e))?;
    if batch.requests.len() > MAX_REFERENCES {
        return Err(Failure::new("limit", "at most 800 metadata references are allowed"));
    }
    if batch.stream && batch.requests.len() != 1 {
        return Err(Failure::new("request", "streaming requires one metadata reference"));
    }
    for reference in &batch.requests {
        if !valid_id(&reference.document_id)
            || reference.version.as_deref().is_some_and(|v| !valid_version(v)) {
            return Err(Failure::new("request", "invalid document ID or version"));
        }
    }
    Ok(batch)
}

fn read_batch(root: &str, batch: Batch) -> Result<Value, Failure> {
    // Open afresh for every batch: no current-head, layout, or inventory cache.
    let repo = OcflRepo::fs_repo(root, None)
        .map_err(|e| Failure::new("storage", e))?;
    let path = LogicalPath::try_from("metadata.json")
        .map_err(|e| Failure::new("storage", e))?;
    let mut metadata = Vec::with_capacity(batch.requests.len());
    let mut remaining = MAX_RESPONSE;
    for reference in batch.requests {
        let version = match reference.version.as_deref() {
            Some(value) => VersionRef::try_from(value)
                .map_err(|e| Failure::new("request", e))?,
            None => VersionRef::Head,
        };
        let mut sink = BoundedBytes { bytes: Vec::new(), limit: remaining, overflowed: false };
        match repo.get_object_file(&reference.document_id, &path, version, &mut sink) {
            Ok(()) => {},
            Err(RocflError::NotFound(_)) => { metadata.push(Value::Null); continue; },
            Err(error) => {
                return Err(Failure::new(if sink.overflowed { "limit" } else { "storage" }, error));
            },
        }
        remaining -= sink.bytes.len();
        let value: Value = serde_json::from_slice(&sink.bytes)
            .map_err(|e| Failure::new("metadata", e))?;
        let actual_version = value.get("version").and_then(Value::as_str);
        if value.get("document_id").and_then(Value::as_str) != Some(reference.document_id.as_str())
            || !actual_version.is_some_and(valid_version)
            || reference.version.as_deref().is_some_and(|v| Some(v) != actual_version) {
            return Err(Failure::new("metadata", "version metadata does not match requested object"));
        }
        metadata.push(value);
    }
    Ok(json!({"ok": true, "metadata": metadata}))
}

// Legacy metadata may exceed the normal batch ceiling. Stream the exact pinned
// library bytes without parsing/buffering the entire record or writing any file.
// The parent stages these bounded frames, requires a successful terminal frame,
// then validates JSON, document identity and version before returning any value.
struct HexFrames<'a, W: Write> {
    output: &'a mut W,
}

impl<W: Write> Write for HexFrames<'_, W> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        const HEX: &[u8; 16] = b"0123456789abcdef";
        for chunk in bytes.chunks(STREAM_CHUNK) {
            let mut frame = Vec::with_capacity(chunk.len() * 2 + 17);
            frame.extend_from_slice(b"{\"chunk_hex\":\"");
            for byte in chunk {
                frame.push(HEX[(byte >> 4) as usize]);
                frame.push(HEX[(byte & 15) as usize]);
            }
            frame.extend_from_slice(b"\"}\n");
            self.output.write_all(&frame)?;
            self.output.flush()?;
        }
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> { self.output.flush() }
}

fn stream_metadata(root: &str, batch: Batch, output: &mut impl Write) -> Result<Value, Failure> {
    let reference = &batch.requests[0]; // parse_batch enforces one validated reference.
    let repo = OcflRepo::fs_repo(root, None)
        .map_err(|e| Failure::new("storage", e))?;
    let path = LogicalPath::try_from("metadata.json")
        .map_err(|e| Failure::new("storage", e))?;
    let version = match reference.version.as_deref() {
        Some(value) => VersionRef::try_from(value)
            .map_err(|e| Failure::new("request", e))?,
        None => VersionRef::Head,
    };
    match repo.get_object_file(&reference.document_id, &path, version, &mut HexFrames { output }) {
        Ok(()) => Ok(json!({"ok": true, "complete": true})),
        Err(RocflError::NotFound(_)) => Ok(json!({"ok": true, "complete": true, "missing": true})),
        Err(error) => Err(Failure::new("storage", error)),
    }
}

fn response_bytes(result: Result<Value, Failure>) -> Vec<u8> {
    let value = match result {
        Ok(value) => value,
        Err(error) => json!({"ok": false, "complete": true,
                             "error": {"kind": error.kind, "message": error.message}}),
    };
    let bytes = serde_json::to_vec(&value).expect("JSON values serialize");
    if bytes.len() > MAX_RESPONSE {
        return br#"{"ok":false,"complete":true,"error":{"kind":"limit","message":"metadata response budget exceeded"}}"#.to_vec();
    }
    bytes
}

fn serve(root: &str, input: impl BufRead, mut output: impl Write) -> io::Result<()> {
    let mut input = input;
    loop {
        let mut line = Vec::new();
        let read = input.by_ref().take((MAX_REQUEST + 1) as u64).read_until(b'\n', &mut line)?;
        if read == 0 { return Ok(()); }
        if line.len() > MAX_REQUEST {
            output.write_all(&response_bytes(Err(Failure::new("limit", "request exceeds 1 MiB"))))?;
            output.write_all(b"\n")?;
            output.flush()?;
            // No resynchronization on attacker-controlled, oversized framing.
            return Ok(());
        }
        let result = match parse_batch(&line) {
            Ok(batch) if batch.stream => stream_metadata(root, batch, &mut output),
            Ok(batch) => read_batch(root, batch),
            Err(error) => Err(error),
        };
        output.write_all(&response_bytes(result))?;
        output.write_all(b"\n")?;
        output.flush()?;
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args.as_slice() == ["--version"] {
        println!("{VERSION}");
        return Ok(());
    }
    if args.len() != 1 { return Err("usage: symbiknow-ocfl-reader <OCFL repository root>".into()); }
    serve(&args[0], io::stdin().lock(), io::stdout().lock())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identifiers_cannot_escape_or_use_padded_versions() {
        for id in ["", "../object", "id/sub", "id\n", "שלום", "_first", "-first"] { assert!(!valid_id(id)); }
        assert!(!valid_id(&"a".repeat(129)));
        assert!(valid_id("A-12_object"));
        for version in ["v0", "v01", "1", "v1 ", "v-1", "v"] { assert!(!valid_version(version)); }
        assert!(valid_version("v1000"));
    }

    #[test]
    fn oversized_request_stops_without_consuming_next_frame() {
        let mut input = vec![b' '; MAX_REQUEST + 1];
        input.extend_from_slice(b"\n{}\n");
        let mut output = Vec::new();
        serve("unused", io::Cursor::new(input), &mut output).unwrap();
        assert_eq!(output.iter().filter(|v| **v == b'\n').count(), 1);
        let value: Value = serde_json::from_slice(&output).unwrap();
        assert_eq!(value["error"]["kind"], "limit");
    }

    #[test]
    fn malformed_bounded_requests_do_not_desynchronize_next_frame() {
        let mut output = Vec::new();
        serve("unused", io::Cursor::new(b"not-json\n{\"requests\":[],\"unexpected\":true}\n"), &mut output).unwrap();
        let lines: Vec<_> = output.split(|v| *v == b'\n').filter(|v| !v.is_empty()).collect();
        assert_eq!(lines.len(), 2);
        for line in lines {
            let value: Value = serde_json::from_slice(line).unwrap();
            assert_eq!(value["error"]["kind"], "request");
        }
    }

    #[test]
    fn metadata_buffer_never_retains_more_than_budget() {
        let mut sink = BoundedBytes { bytes: Vec::new(), limit: 4, overflowed: false };
        sink.write_all(b"1234").unwrap();
        assert!(sink.write_all(b"5").is_err());
        assert!(sink.overflowed);
        assert_eq!(sink.bytes, b"1234");
    }

    #[test]
    fn streaming_frames_are_bounded_and_preserve_all_byte_values() {
        let bytes: Vec<u8> = (0..(STREAM_CHUNK * 3 + 7)).map(|i| (i % 256) as u8).collect();
        let mut output = Vec::new();
        HexFrames { output: &mut output }.write_all(&bytes).unwrap();
        let mut restored = Vec::new();
        for line in output.split(|b| *b == b'\n').filter(|line| !line.is_empty()) {
            assert!(line.len() <= STREAM_CHUNK * 2 + 16);
            let frame: Value = serde_json::from_slice(line).unwrap();
            let hex = frame["chunk_hex"].as_str().unwrap();
            for index in (0..hex.len()).step_by(2) {
                restored.push(u8::from_str_radix(&hex[index..index + 2], 16).unwrap());
            }
        }
        assert_eq!(restored, bytes);
    }

    #[test]
    fn stream_validates_identity_and_count_before_emitting_bytes() {
        for input in [
            br#"{"requests":[],"stream":true}"#.as_slice(),
            br#"{"requests":[{"document_id":"../escape"}],"stream":true}"#.as_slice(),
            br#"{"requests":[{"document_id":"first"},{"document_id":"second"}],"stream":true}"#.as_slice(),
        ] {
            assert!(parse_batch(input).is_err());
        }
    }
}
