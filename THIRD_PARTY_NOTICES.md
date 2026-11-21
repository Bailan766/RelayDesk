# Third-party notices

The Windows build distributes sing-box 1.14.4 as a separate executable.

- Project and source: https://github.com/SagerNet/sing-box
- License: GNU General Public License, version 3. The complete license is included in the build artifact as `THIRD-PARTY-SING-BOX-LICENSE.txt`.
- Release: https://github.com/SagerNet/sing-box/releases/tag/v1.14.4

The Windows build also distributes the upstream Mihomo 1.19.34 Windows amd64 v1 executable.

- Project and source: https://github.com/MetaCubeX/mihomo/tree/v1.19.34
- License: GNU General Public License, version 3. The complete license is included as `THIRD-PARTY-MIHOMO-LICENSE.txt`.
- Release, source archives, vendor dependencies and toolchain: https://github.com/MetaCubeX/mihomo/releases/tag/v1.19.34

The Windows build also bundles GeoIP databases (`Country.mmdb` and `geoip.metadb`) built by `MetaCubeX/meta-rules-dat` using MaxMind GeoLite2 data so Mihomo starts offline without blocking on first-run downloads.

- Project: https://github.com/MetaCubeX/meta-rules-dat

RelayDesk's own source code is licensed under the MIT license. Both proxy cores run as separate programs under their respective licenses.
