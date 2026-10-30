# Indesignal audio publisher

Prepares the existing Heart female narration once, then publishes small MP3 files to the Indesignal portal. Visitors stream the ready audio; they do not download a voice model or synthesize speech on their phones.

This repository contains only the generator and its workflow. It does not contain portal source, an editorial feed snapshot, account credentials, model weights or recordings.

## Daily operation

The standard GitHub-hosted Ubuntu job runs after the portal's daily editorial update, at 08:25 and 09:25 Asia/Kolkata. It can also be started from Actions → Publish Indesignal audio → Run workflow. Pushes to `main` run it as well. Runs are serialized, with a 120-minute ceiling. GitHub schedules are best effort: they can be delayed or dropped, and public-repository schedules stop after 60 days without repository activity. Check Actions failures and re-enable a disabled schedule when needed.

The job asks the portal for missing current audio, prepares the daily brief first, and uploads each completed file immediately. Stories that already have matching audio are skipped. Revised text creates a new content hash and fresh narration; an obsolete upload is rejected and the job checks the queue once again. The first backfill of older articles takes longer; subsequent runs only synthesize missing or changed scripts.

Node.js 24, pinned Kokoro-JS 1.2.1, Transformers 3.5.1, Kokoro q8 CPU and `af_heart` provide the voice. FFmpeg writes mono 24 kHz MP3 at 64 kbps. Public model files are cached; audio and intermediate files are not retained as GitHub artifacts.

## Authorization

The one repository secret is `SITES_SERVICE_TOKEN`, the existing Sites service-access token for this portal. Keep it in **Settings → Secrets and variables → Actions**, never source code. It permits the job to reach Sites dispatch; it does not grant editorial identity or permission to change the news.

For audio writes the job requests a short-lived GitHub OIDC token with audience `https://indesignal.vividtoad4096.chatgpt.site/api/editorial/narration`. The portal validates GitHub's signature, immutable repository ID, owner, `main` branch, workflow path and permitted trigger. There is no permanent audio-upload password in this repository. Pull requests and forks cannot upload narration. If the repository is renamed or replaced, update the portal's explicit allowlist before expecting writes to succeed.

The exact current canonical narration comes from the portal. This code never constructs a separate news script. It checks the text hash before synthesis, uploads using that hash, and verifies both response metadata and complete downloaded bytes. Tokens and scripts are not printed in job logs. Model/voice software and their licenses remain with their respective authors; Kokoro weights are Apache-2.0 licensed.

## Cost and maintenance

This workflow uses standard public-repository runners, which GitHub currently provides without runner charges. It does not request larger runners, paid inference, external speech subscriptions or audio artifact storage. It does not change GitHub billing settings. GitHub policies, quotas and availability still apply. The existing portal hosts the MP3s using its configured storage.

Sources: [GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions), [scheduled-run limitations](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule), [Kokoro model](https://huggingface.co/hexgrad/Kokoro-82M).

## Local checks

Run `node --test test.mjs` without downloading any model. To run the actual publisher, install dependencies with `pnpm install --frozen-lockfile` and start it in GitHub Actions, where GitHub issues the required OIDC token. Normal developer shells do not have upload authority.
