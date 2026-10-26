//! Shared integration-test clock for the sandbox.
use anyhow::{Result, ensure};
use near_workspaces::{Worker, network::Sandbox};
use std::time::Duration;

/// Wait for an actual chain timestamp, rather than assuming one second per block.
/// Block production and wall-clock waiting are centralized here for every time-dependent test.
pub async fn wait_until_timestamp(worker: &Worker<Sandbox>, target_ns: u64) -> Result<()> {
    let initial = worker.view_block().await?.timestamp();
    let timeout = Duration::from_nanos(target_ns.saturating_sub(initial)) + Duration::from_secs(30);
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        let now = worker.view_block().await?.timestamp();
        if now > target_ns {
            return Ok(());
        }
        ensure!(
            tokio::time::Instant::now() < deadline,
            "sandbox timestamp did not pass {target_ns}; latest {now}"
        );
        worker.fast_forward(1).await?;
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}
