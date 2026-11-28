# Third-party notices

The Windows build distributes sing-box 1.15.0-alpha.14 as a separate executable.

- Project and source: https://github.com/SagerNet/sing-box
- License: GNU General Public License, version 3. The complete license is included in the build artifact as `THIRD-PARTY-SING-BOX-LICENSE.txt`.
- Release: https://github.com/SagerNet/sing-box/releases/tag/v1.15.0-alpha.14

The Windows build also distributes the upstream Mihomo 1.19.34 Windows amd64 v1 executable.

- Project and source: https://github.com/MetaCubeX/mihomo/tree/v1.19.34
- License: GNU General Public License, version 3. The complete license is included as `THIRD-PARTY-MIHOMO-LICENSE.txt`.
- Release, source archives, vendor dependencies and toolchain: https://github.com/MetaCubeX/mihomo/releases/tag/v1.19.34

The Windows build also bundles GeoIP databases (`Country.mmdb` and `geoip.metadb`) built by `MetaCubeX/meta-rules-dat` using MaxMind GeoLite2 data so Mihomo starts offline without blocking on first-run downloads.

- Project: https://github.com/MetaCubeX/meta-rules-dat

The Windows build also bundles the signed Wintun 0.14.1 driver library (`wintun.dll`) by WireGuard LLC for native Mihomo TUN support.

- Project: https://www.wintun.net/
- License: Included as `THIRD-PARTY-WINTUN-LICENSE.txt`.

RelayDesk's own source code is licensed under the MIT license. Both proxy cores run as separate programs under their respective licenses.
