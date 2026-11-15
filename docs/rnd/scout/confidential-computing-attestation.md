# Scout: Confidential Computing & Remote Attestation

Area: **confidential-computing-attestation** — the Phase-3 "we couldn't read it even if we tried, and here's proof" layer.
Goal: run the MESH gateway's blind data-plane inside a TEE (AWS Nitro Enclave first) and let any client *verify* the exact binary that ran.
Date: 2026-10-29. MESH license: **BUSL-1.1** (so GPL deps are a problem; MIT/Apache/MPL are fine).

## The honest shape of this

MESH is pure-TS/Node. The enclave world is overwhelmingly Rust/Go/C. The realistic split is:
- **Inside the enclave**: a thin Go/Rust supervisor (TLS termination + attestation endpoint + vsock↔IP) wraps the unchanged MESH Node proxy. MESH does **not** rewrite its proxy — it runs as the enclave's "application".
- **Client side (TS)**: MESH ships a verifier so a customer can fetch the attestation doc, check the cert chain to the AWS Nitro root, and pin the PCRs of the published image. This is the part MESH writes/vendors in its own stack.

So the two things MESH actually *depends on* are (a) a supervisor-in-enclave pattern and (b) a TS attestation verifier. Everything else is reference.

## Ranked repos

### 1. brave/nitriding-daemon — the reference architecture (copy-pattern)
- https://github.com/brave/nitriding-daemon · Go · MPL-2.0 · ~56★ · **archived 2026-10-25** (points users to Veil, #5)
- Toolkit to run a networked service in a Nitro Enclave: auto-HTTPS (Let's Encrypt), TLS-terminating reverse proxy in front of your app, an HTTPS **attestation endpoint**, transparent vsock↔IP via a TAP interface, and key-sync between identical enclaves. Lets users register a hash over the app's public key material so it's bound into the attestation doc.
- **MESH borrows**: the entire gateway-in-enclave *shape* — run the Node proxy unchanged behind nitriding, expose `/attestation`, bind the proxy's TLS pubkey into the doc. This is exactly MESH's "one base URL, provably blind" install. MPL-2.0 is file-level copyleft and it runs as a **separate process**, so no BUSL contamination. Archived, so treat as the canonical design to re-implement/fork rather than a live dependency.

### 2. aws/aws-nitro-enclaves-nsm-api — produce the attestation doc (adopt as in-enclave dep)
- https://github.com/aws/aws-nitro-enclaves-nsm-api · Rust (+C ffi) · Apache-2.0 · ~86★ · actively maintained by AWS
- The Nitro Secure Module API: request attestation documents (CBOR/COSE_Sign1, signed by the AWS Nitro PKI), PCR query/manip, entropy. This is the ground-truth source of the attestation.
- **MESH borrows**: whatever supervisor runs inside the enclave calls this to mint the doc (and to pull in a nonce + the proxy's pubkey as UserData/PublicKey). Clean Apache-2.0, first-party AWS. Non-negotiable building block for the Nitro path.

### 3. @epsilon-data/nitro-verify — the client-side verifier in MESH's own stack (adopt/vendor)
- https://github.com/Epsilon-Data/nitro-verify (npm `@epsilon-data/nitro-verify`) · TypeScript · MIT · ~0★ · small/new (10 commits)
- Verifies Nitro attestation docs in **Node 18+ and the browser (WebCrypto)**: decodes CBOR/COSE_Sign1, validates the structure, walks the X.509 chain to the AWS Nitro root, checks PCRs, and compares an output hash.
- **MESH borrows**: the only option that's *already in MESH's language*. This is the "customer verifies us" library — ship it (or vendor its ~small code) so MESH's SDK/CLI can pin the published PCRs and confirm the blind gateway is the exact audited binary. MIT = free to vendor. Traction is basically zero, so **vet/pin the code and vendor it** rather than taking a live dependency; the crypto is standard and auditable.

### 4. aws/aws-nitro-enclaves-sdk-c — seal secrets to the attestation (study / copy-pattern)
- https://github.com/aws/aws-nitro-enclaves-sdk-c · C · Apache-2.0 · first-party AWS, maintained
- C API + a KMS SDK that integrates attestation: generates the RSA keypair, embeds the public key in the attestation request, and uses KMS so a key is only released to an enclave whose PCRs match a policy.
- **MESH borrows**: the **KMS-key-release-gated-on-PCRs** pattern — this is how the "sealed key" in Phase-2/3 actually works (the `MESH_PROXY_BLIND_KEY` becomes a key KMS will only decrypt for the attested enclave). Copy the condition-key policy design; MESH won't link the C library itself.

### 5. Amnesic-Systems/veil — the maintained nitriding successor (study-only, GPL caveat)
- https://github.com/Amnesic-Systems/veil · Go · **GPL-3.0** · ~7★ · active (258 commits), the project nitriding now redirects to
- Same idea as nitriding, split cleanly into `veil-daemon` (in-enclave), `veil-proxy` (EC2 host), and `veil-verify` (validates enclave integrity).
- **MESH borrows**: the `veil-verify` flow and the daemon/host-proxy split are worth reading as the *current* state of the art. **License risk**: GPL-3.0 — fine to run the daemon as a standalone binary alongside MESH (aggregation), but do **not** copy GPL Go source into MESH's BUSL code, and MESH's own supervisor should be a clean-room re-implementation of the nitriding (MPL) pattern, not a veil fork.

### 6. confidential-containers/trustee (KBS) — attestation-gated key broker (architecture idea)
- https://github.com/confidential-containers/trustee · Rust · Apache-2.0 · CNCF Confidential Containers, actively maintained, multi-TEE (SEV-SNP, TDX, and Nitro via plugins)
- A Key Broker Service: a Relying Party that runs a challenge-response, verifies attestation evidence against policy, and only then releases secrets. TEE-agnostic.
- **MESH borrows**: the **attestation-as-authorization** architecture if MESH ever wants provider-agnostic confidential compute (not just Nitro). Heavier than MESH needs for a single-gateway v1; park it as the scaling story. Apache-2.0, so no license issue if adopted later.

## Not recommended
- **enarx/enarx** (Apache-2.0, ~1.4k★): WASM-in-TEE runtime. Would force rewriting the MESH proxy to WASM and the project has stalled — wrong fit, **reject**.

## Bottom line for MESH
A credible Nitro path is: **nitriding-pattern supervisor (MPL, re-implemented)** wrapping the unchanged Node proxy, **nsm-api (Apache)** inside to mint the doc, **KMS condition-key sealing (SDK-c pattern)** for the blind key, and **nitro-verify (MIT, vendored)** shipped to customers so they can verify the PCRs themselves. That makes "we couldn't read it even if we tried" a thing the client checks, not a claim MESH makes. Everything load-bearing is MIT/Apache/MPL — BUSL-clean. The one trap is Veil (GPL-3.0): read it, don't vendor it.
