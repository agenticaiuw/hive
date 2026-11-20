#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
archive_root="${project_root}/build/ios"
build_number="${HIVE_BUILD_NUMBER:-$(date +%Y%m%d%H%M)}"
archive_path="${archive_root}/Hive-${build_number}.xcarchive"
export_path="${archive_root}/export-${build_number}"
# The Apple team is the one this Mac signs with (its Apple Development or Distribution certificate),
# so the repository names no team. HIVE_APPLE_TEAM_ID picks one when the Mac has several.
signing_teams() {
  security find-identity -v -p codesigning 2>/dev/null \
    | grep -oE '"Apple (Distribution|Development): [^"]+"' | tr -d '"' \
    | while IFS= read -r name; do
        security find-certificate -c "${name}" -p 2>/dev/null \
          | openssl x509 -noout -subject -nameopt multiline 2>/dev/null \
          | sed -n 's/^ *organizationalUnitName *= *//p'
      done | sort -u
}
team_id="${HIVE_APPLE_TEAM_ID:-}"
if [[ -z "${team_id}" ]]; then
  teams="$(signing_teams)"
  count="$(printf '%s' "${teams}" | grep -c . || true)"
  if [[ "${count}" != "1" ]]; then
    echo "This Mac has ${count} Apple signing teams; set HIVE_APPLE_TEAM_ID to the one to archive with." >&2
    exit 1
  fi
  team_id="${teams}"
fi
bundle_id="${HIVE_BUNDLE_ID:-com.evanliu.hive}"

cd "${project_root}"
npm run ios:sync

xcodebuild \
  -project ios/App/App.xcodeproj \
  -scheme App \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  -archivePath "${archive_path}" \
  -allowProvisioningUpdates \
  DEVELOPMENT_TEAM="${team_id}" \
  PRODUCT_BUNDLE_IDENTIFIER="${bundle_id}" \
  CURRENT_PROJECT_VERSION="${build_number}" \
  clean archive

if [[ "${HIVE_UPLOAD_TESTFLIGHT:-0}" != "1" ]]; then
  echo "Archive created at ${archive_path}"
  exit 0
fi

export_options="${archive_root}/ExportOptions-${build_number}.plist"
cp ios/TestFlightExportOptions.plist "${export_options}"
plutil -replace teamID -string "${team_id}" "${export_options}"

xcodebuild \
  -exportArchive \
  -archivePath "${archive_path}" \
  -exportPath "${export_path}" \
  -exportOptionsPlist "${export_options}" \
  -allowProvisioningUpdates

echo "The archive was submitted to App Store Connect for TestFlight processing."
