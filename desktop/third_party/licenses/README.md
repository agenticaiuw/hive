# Supplemental third-party license notices

These notices accompany the expanded headers under
`desktop/app/third_party/Karabiner-DriverKit-VirtualHIDDevice/vendor/vendor/include`.
They do not replace each component's retained per-file copyright notices or
other bundled licenses. The fmt notice remains beside the vendored fmt files.

| Component | Evidence in imported headers | License text |
| --- | --- | --- |
| Asio | `asio/version.hpp` declares 1.38.0; `asio.hpp` names Boost Software License 1.0 | [Boost 1.0](boost-1.0.txt) |
| type_safe | `type_safe/optional.hpp` names Jonathan Müller and its top-level LICENSE; that one header matches upstream commit `292e8c127037e33d92f8f52dab0f1184993942d0` by SHA-256 | [type_safe](type_safe.txt) |
| spdlog | `spdlog/version.h` declares 1.17.0 and matches upstream tag `v1.17.0` by SHA-256 | [spdlog 1.17.0](spdlog-1.17.0.txt) |
| nlohmann/json | `nlohmann/json.hpp` declares 3.12.0 and matches upstream tag `v3.12.0` by SHA-256 | [nlohmann/json 3.12.0](nlohmann-json-3.12.0.txt) |
| glob | `glob/glob.hpp` matches upstream commit `6f06567bd87f83e193eb69d9aa83335be63f5620` by SHA-256 | [glob](glob.txt) |
| nod | `nod/nod.hpp` matches upstream commit `23e4190f3d15964dd1f00677120a788824d74ec9` by SHA-256 | [nod](nod.txt) |

License sources: [Boost](https://github.com/boostorg/boost/blob/boost-1.85.0/LICENSE_1_0.txt),
[type_safe](https://github.com/foonathan/type_safe/blob/292e8c127037e33d92f8f52dab0f1184993942d0/LICENSE),
[spdlog](https://github.com/gabime/spdlog/blob/v1.17.0/LICENSE),
[nlohmann/json](https://github.com/nlohmann/json/blob/v3.12.0/LICENSE.MIT),
[glob](https://github.com/p-ranav/glob/blob/6f06567bd87f83e193eb69d9aa83335be63f5620/LICENSE),
[nod](https://github.com/fr00b0/nod/blob/23e4190f3d15964dd1f00677120a788824d74ec9/LICENSE).
Single-header comparisons do not establish the exact version or completeness
of every vendored file. A full third-party and repository license audit remains
required before publication.
