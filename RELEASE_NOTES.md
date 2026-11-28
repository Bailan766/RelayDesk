# RelayDesk 1.7.1

Fixes Hysteria2 certificate pinning and upgrades the Windows bundled core.

- Upgrade sing-box to `1.15.0-alpha.14`.
- Convert Hysteria2 `pinSHA256` to sing-box `tls.certificate_sha256` without dropping certificate verification.
- Remove the deprecated sing-box 1.15 TUN `stack` field that required the removed `with_gvisor` build tag.
- Bundle sing-box `libcronet.dll` and verify it in the Windows installer smoke test.
- Windows/MSVC build, TUN recovery, and installer smoke tests pass.
