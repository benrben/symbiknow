//! Benchmark-only fixture writer. Never used by the running application.
use rocfl::ocfl::{CommitMeta, DigestAlgorithm, LayoutExtensionName, OcflRepo, SpecVersion, StorageLayout};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{error::Error, fs, io::{self, BufRead, Read}, path::PathBuf,
    sync::{mpsc, Arc, atomic::{AtomicUsize, Ordering}}, thread, time::Instant};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Fixture {
    metadata: Value,
    original: String,
}

fn write_fixtures(repo: Arc<OcflRepo>, scratch: PathBuf, input: mpsc::Receiver<Fixture>,
    completed: Arc<AtomicUsize>, start: Instant) -> Result<usize, Box<dyn Error>> {
    fs::create_dir(&scratch)?;
    let original = scratch.join("original");
    let metadata = scratch.join("metadata.json");
    let mut count = 0;
    for fixture in input {
        let id = fixture.metadata["document_id"].as_str().ok_or("missing document_id")?;
        fs::write(&original, fixture.original.as_bytes())?;
        fs::write(&metadata, serde_json::to_vec(&fixture.metadata)?)?;
        repo.create_object(id, None, DigestAlgorithm::Sha512, "content", 0)?;
        repo.copy_files_external(id, &[&original, &metadata], "/", false)?;
        repo.commit(id, CommitMeta::new()
            .with_user(Some("Symbiknow capacity benchmark".into()), None)?
            .with_message(Some("synthetic capacity fixture".into())), None, false)?;
        count += 1;
        let total = completed.fetch_add(1, Ordering::Relaxed) + 1;
        if total % 1000 == 0 { eprintln!("committed {total} fixtures in {:.1}s", start.elapsed().as_secs_f64()); }
    }
    fs::remove_file(original).ok();
    fs::remove_file(metadata).ok();
    fs::remove_dir(scratch)?;
    Ok(count)
}

fn main() -> Result<(), Box<dyn Error>> {
    let mut args = std::env::args().skip(1);
    let root = PathBuf::from(args.next().ok_or("expected NEW OCFL root")?);
    let workers: usize = args.next().unwrap_or_else(|| "4".into()).parse()?;
    if !(1..=8).contains(&workers) || args.next().is_some() {
        return Err("expected NEW OCFL root and optional worker count (1..8)".into());
    }
    if root.exists() { return Err("fixture destination must not exist".into()); }
    // create_dir is exclusive: a concurrent creator must not turn this into an overwrite.
    fs::create_dir(&root)?;
    let repo = Arc::new(OcflRepo::init_fs_repo(&root, None, SpecVersion::Ocfl1_1,
        Some(StorageLayout::new(LayoutExtensionName::HashedNTupleLayout, None)?))?);
    let scratch = root.join("extensions").join("symbiknow-benchmark-input");
    fs::create_dir(&scratch)?;
    let start = Instant::now();
    let completed = Arc::new(AtomicUsize::new(0));
    let mut senders = Vec::new();
    let mut handles = Vec::new();
    for worker in 0..workers {
        let (sender, receiver) = mpsc::sync_channel::<Fixture>(2);
        let owner = Arc::clone(&repo);
        let counter = Arc::clone(&completed);
        let directory = scratch.join(worker.to_string());
        senders.push(sender);
        handles.push(thread::spawn(move || write_fixtures(owner, directory, receiver, counter, start)
            .map_err(|error| error.to_string())));
    }
    let mut count = 0usize;
    let mut input = io::stdin().lock();
    loop {
        let mut line = Vec::new();
        let length = (&mut input).take(1024 * 1024 + 1).read_until(b'\n', &mut line)?;
        if length == 0 { break; }
        if length > 1024 * 1024 { return Err("fixture line exceeds 1 MiB".into()); }
        let fixture: Fixture = serde_json::from_slice(&line)?;
        let id = fixture.metadata["document_id"].as_str().ok_or("missing document_id")?;
        if id.is_empty() || id.len() > 128 || !id.as_bytes()[0].is_ascii_alphanumeric()
            || !id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
            || fixture.metadata["version"] != "v1" {
            return Err("invalid fixture identity/version".into());
        }
        senders[count % workers].send(fixture).map_err(|_| "fixture worker failed")?;
        count += 1;
    }
    drop(senders);
    let mut committed = 0;
    for handle in handles {
        committed += handle.join().map_err(|_| "fixture worker panicked")??;
    }
    if committed != count { return Err("incomplete fixture commit count".into()); }
    fs::remove_dir(scratch)?;
    println!("{}", json!({"documents": committed, "seconds": start.elapsed().as_secs_f64(),
        "workers": workers, "synthetic": true}));
    Ok(())
}
