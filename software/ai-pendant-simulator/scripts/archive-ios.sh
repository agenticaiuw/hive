#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
archive_root="${project_root}/build/ios"
build_number="${PENDANT_BUILD_NUMBER:-$(date +%Y%m%d%H%M)}"
archive_path="${archive_root}/AI-Pendant-${build_number}.xcarchive"
export_path="${archive_root}/export-${build_number}"
team_id="${PENDANT_APPLE_TEAM_ID:-9684Z8GZ26}"
bundle_id="${PENDANT_BUNDLE_ID:-com.aipendant.app}"

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

if [[ "${PENDANT_UPLOAD_TESTFLIGHT:-0}" != "1" ]]; then
  echo "Archive created at ${archive_path}"
  exit 0
fi

xcodebuild \
  -exportArchive \
  -archivePath "${archive_path}" \
  -exportPath "${export_path}" \
  -exportOptionsPlist ios/TestFlightExportOptions.plist \
  -allowProvisioningUpdates

echo "The archive was submitted to App Store Connect for TestFlight processing."
