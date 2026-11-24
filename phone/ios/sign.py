#!/usr/bin/env python3
"""CI-only signing. Secret values and decoded profiles never enter build logs.
IOS_PROFILE may hold one profile, or a zip of profiles for the app and extension.
"""
import datetime
import hashlib
import os
from pathlib import Path
import plistlib
import re
import subprocess
import sys
import tempfile
import zipfile


class SigningError(RuntimeError):
    pass


def run(*args):
    result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if result.returncode:
        raise SigningError(f"{args[0]} failed during iOS signing")
    return result.stdout


def select(profiles, bundle_id, network):
    for raw, profile in profiles:
        entitlements = profile.get("Entitlements", {})
        app_id = entitlements.get("application-identifier", "")
        prefix, _, suffix = app_id.partition(".")
        if suffix != bundle_id:
            continue
        if profile.get("ExpirationDate", datetime.datetime.min) <= datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None):
            continue
        if network and "packet-tunnel-provider" not in entitlements.get("com.apple.developer.networking.networkextension", []):
            continue
        entitlements = dict(entitlements)
        entitlements["application-identifier"] = f"{prefix}.{bundle_id}"
        return raw, profile, entitlements
    raise SigningError(f"IOS_PROFILE needs a current profile for {bundle_id}" + (" with Network Extensions enabled" if network else ""))


def sign(app, source):
    with tempfile.TemporaryDirectory(prefix="hive-ios-sign-", dir=os.environ.get("RUNNER_TEMP")) as temporary:
        temporary = Path(temporary)
        profiles = []
        if zipfile.is_zipfile(source):
            with zipfile.ZipFile(source) as archive:
                payloads = [archive.read(name) for name in archive.namelist() if name.endswith(".mobileprovision") and not name.startswith("__MACOSX/")]
        else:
            payloads = [source.read_bytes()]
        for index, raw in enumerate(payloads):
            path = temporary / f"profile-{index}.mobileprovision"
            path.write_bytes(raw)
            os.chmod(path, 0o600)
            profile = plistlib.loads(run("security", "cms", "-D", "-i", str(path)))
            profiles.append((raw, profile))
        extensions = sorted(app.glob("PlugIns/*.appex"))
        bundles = extensions + [app]
        chosen = []
        for bundle in bundles:
            with (bundle / "Info.plist").open("rb") as file:
                info = plistlib.load(file)
            raw, profile, entitlements = select(profiles, info["CFBundleIdentifier"], bool(extensions))
            chosen.append((bundle, raw, profile, entitlements))
        # One identity must be authorized by every component's profile.
        certificates = set.intersection(*[
            {hashlib.sha1(cert).hexdigest().upper() for cert in profile.get("DeveloperCertificates", [])}
            for _, _, profile, _ in chosen
        ])
        identities = run("security", "find-identity", "-v", "-p", "codesigning").decode()
        available = set(re.findall(r"\b[0-9A-F]{40}\b", identities))
        common = certificates & available
        if not common:
            raise SigningError("No installed signing identity matches every iOS profile")
        signer = sorted(common)[0]
        for item in sorted(app.rglob("*"), key=lambda p: len(p.parts), reverse=True):
            if item.suffix in (".framework", ".xctest", ".dylib"):
                run("codesign", "-f", "-s", signer, "--timestamp=none", str(item))
        for index, (bundle, raw, profile, entitlements) in enumerate(chosen):
            (bundle / "embedded.mobileprovision").write_bytes(raw)
            path = temporary / f"entitlements-{index}.plist"
            path.write_bytes(plistlib.dumps(entitlements))
            run("codesign", "-f", "-s", signer, "--timestamp=none", "--entitlements", str(path), str(bundle))
        run("codesign", "--verify", "--deep", "--strict", str(app))


if __name__ == "__main__":
    try:
        sign(Path(sys.argv[1]), Path(os.environ["HIVE_IOS_PROFILE"]))
    except SigningError as error:
        print(f"iOS signing failed: {error}", file=sys.stderr)
        sys.exit(1)
    except Exception:
        # Third-party parsers and filesystem exceptions may embed profile
        # contents, archive entry names or secret paths in their messages.
        print("iOS signing failed: invalid signing input or unavailable signing tools", file=sys.stderr)
        sys.exit(1)
