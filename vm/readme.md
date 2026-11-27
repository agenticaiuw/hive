# Hive VM

## Oracle Cloud

We use an Oracle Cloud always free VM instance, shape `VM.Standard.A1.Flex`, which has an ARM processor.

We assume you already have an Oracle cloud account, with the payment plan on the **pay as you go** subscription.

- Note: the Oracle Cloud Free Tier (30 day trial with $300 credits) is likely to run into issues with VM availability. Upgrade your account to PAYG [here](https://cloud.oracle.com/invoices-and-orders/upgrade-and-payment)

## Terraform

To automate VM provisioning (to avoid manually clicking through the web UI cloud console), we use terraform via the Oracle Cloud Shell. The main design principle is to make the workflow repeatable and recoverable.

- Terraform creates and manages OCI resources: the VM, networking, and related cloud configuration.

This keeps every club member's VM instance in its member’s own tenancy/subscription. The club repository supplies the configuration; it should never hold credentials or Terraform state.

Current status: stub `main.tf` implemented

## Ansible

Ansible configures software and settings inside the VM: packages, users, services, firewall, and club-specific tools.

This mainly serves to configure podman to run the container of the hive `server`

Current status: implementation TODO.

## Provision Script

This is the main entry point for club members to conveniently paste into the cloud shell and run.

Current status: stub `provision.sh` implemented.
