#!/usr/bin/env bash
set -euo pipefail

REPO_URL="https://github.com/agenticaiuw/hive.git"
REPO_DIR="$HOME/hive"
TF_DIR="$REPO_DIR/vm"

die() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

for cmd in oci terraform git python3; do
  command -v "$cmd" >/dev/null || die "Required command not found: $cmd"
done

# Cloud Shell sets OCI_CLI_PROFILE to the active region profile.
PROFILE="${OCI_CLI_PROFILE:-DEFAULT}"
DETECTED_REGION="${OCI_CLI_REGION:-}"

if [[ -z "$DETECTED_REGION" ]]; then
  CONFIG_FILE="${OCI_CLI_CONFIG_FILE:-/etc/oci/config}"
  [[ -r "$CONFIG_FILE" ]] || CONFIG_FILE="$HOME/.oci/config"

  if [[ -r "$CONFIG_FILE" ]]; then
    DETECTED_REGION="$(
      python3 - "$CONFIG_FILE" "$PROFILE" <<'PY'
import configparser, sys
cfg = configparser.ConfigParser()
cfg.read(sys.argv[1])
profile = sys.argv[2]
if cfg.has_section(profile):
    print(cfg.get(profile, "region", fallback=""))
PY
    )"
  fi
fi

[[ -n "$DETECTED_REGION" ]] || die \
  "Could not detect OCI region. Set OCI_CLI_REGION or OCI_CLI_PROFILE, then retry."

printf 'Detected OCI region: %s (profile: %s)\n' "$DETECTED_REGION" "$PROFILE"
read -r -p "Use this region? [Y/n] " answer
if [[ "$answer" =~ ^[Nn]$ ]]; then
  read -r -p "Enter OCI region name (e.g. us-ashburn-1): " REGION
  [[ -n "$REGION" ]] || die "Region cannot be empty."
else
  REGION="$DETECTED_REGION"
fi

read -r -p "Enter the compartment OCID for the VM: " COMPARTMENT_OCID
[[ "$COMPARTMENT_OCID" == ocid1.* ]] || die "That does not look like a compartment OCID."

printf '\nChecking for an existing active A1 VM in this compartment and region...\n'
INSTANCES_JSON="$(oci compute instance list \
  --compartment-id "$COMPARTMENT_OCID" \
  --all \
  --region "$REGION" \
  --output json)" || die "OCI instance query failed; no repo was cloned."

EXISTING="$(
  python3 -c '
import json, sys
data = json.load(sys.stdin).get("data", [])
matches = [
    i for i in data
    if i.get("shape") == "VM.Standard.A1.Flex"
    and i.get("lifecycle-state") not in ("TERMINATED", "TERMINATING")
]
for i in matches:
    print("{} | {} | {}".format(
        i.get("display-name", "(unnamed)"),
        i.get("lifecycle-state", "unknown"),
        i.get("id", "")
    ))
' <<<"$INSTANCES_JSON"
)"

if [[ -n "$EXISTING" ]]; then
  printf '\nAn active A1 instance already exists in that compartment/region:\n%s\n' "$EXISTING"
  die "Stopping before cloning or running Terraform. Review the instance and Terraform state first."
fi

printf 'No active A1 instance found in that compartment and region.\n\n'

if [[ -e "$REPO_DIR" ]]; then
  die "$REPO_DIR already exists. Inspect it or move it before rerunning."
fi

git clone "$REPO_URL" "$REPO_DIR"
[[ -d "$TF_DIR" ]] || die "Terraform directory not found: $TF_DIR"
cd "$TF_DIR"

# These values are written locally and should not be committed.
read -r -p "Enter availability domain: " AVAILABILITY_DOMAIN
read -r -p "Enter the ARM-compatible image OCID: " IMAGE_OCID
read -r -p "Path to your SSH public key: " SSH_KEY_PATH
read -r -p "SSH source CIDR (your public IP with /32 is recommended): " SSH_CIDR

[[ -r "$SSH_KEY_PATH" ]] || die "Cannot read SSH public key: $SSH_KEY_PATH"
SSH_PUBLIC_KEY="$(cat "$SSH_KEY_PATH")"

umask 077
cat >terraform.tfvars <<EOF
region              = "$REGION"
compartment_ocid     = "$COMPARTMENT_OCID"
availability_domain = "$AVAILABILITY_DOMAIN"
image_ocid           = "$IMAGE_OCID"
ssh_public_key       = "$SSH_PUBLIC_KEY"
ssh_ingress_cidr     = "$SSH_CIDR"
EOF

terraform init
terraform validate
terraform plan -out=club-vm.tfplan

printf '\nReview the plan above carefully. It can create billable resources if they are not Always Free eligible.\n'
read -r -p "Apply this exact plan? Type 'yes' to continue: " APPROVE
[[ "$APPROVE" == "yes" ]] || die "Not applying. The plan file remains at $TF_DIR/club-vm.tfplan."

terraform apply club-vm.tfplan
terraform output
