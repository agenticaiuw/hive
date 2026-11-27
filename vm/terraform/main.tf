variable "region"       { type = string }
variable "availability_domain" { type = string }
variable "image_ocid"   { type = string }
variable "ssh_public_key" { type = string }
variable "ssh_ingress_cidr" {
  type        = string
  description = "Your public IP/CIDR for SSH, e.g. 203.0.113.10/32"
}

provider "oci" {
  region              = var.region
  auth                = "SecurityToken"
  config_file_profile = "DEFAULT"
}

data "oci_identity_availability_domains" "ads" {
  compartment_id = var.compartment_ocid
}

variable "compartment_ocid" { type = string }

resource "oci_core_vcn" "club" {
  compartment_id = var.compartment_ocid
  display_name   = "club-vcn"
  cidr_block     = "10.0.0.0/16"
  dns_label      = "clubvcn"
}

resource "oci_core_internet_gateway" "igw" {
  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.club.id
  display_name   = "club-igw"
  enabled        = true
}

resource "oci_core_route_table" "public" {
  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.club.id
  display_name   = "club-public-routes"

  route_rules {
    network_entity_id = oci_core_internet_gateway.igw.id
    destination       = "0.0.0.0/0"
    destination_type  = "CIDR_BLOCK"
  }
}

resource "oci_core_security_list" "public" {
  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.club.id
  display_name   = "club-public-security"

  egress_security_rules {
    destination = "0.0.0.0/0"
    protocol    = "all"
  }

  ingress_security_rules {
    source   = var.ssh_ingress_cidr
    protocol = "6"

    tcp_options {
      min = 22
      max = 22
    }
  }
}

resource "oci_core_subnet" "public" {
  compartment_id             = var.compartment_ocid
  vcn_id                     = oci_core_vcn.club.id
  display_name               = "club-public-subnet"
  cidr_block                 = "10.0.1.0/24"
  route_table_id             = oci_core_route_table.public.id
  security_list_ids          = [oci_core_security_list.public.id]
  prohibit_public_ip_on_vnic = false
  dns_label                  = "public"
}

resource "oci_core_instance" "vm" {
  compartment_id      = var.compartment_ocid
  availability_domain = var.availability_domain
  display_name        = "club-a1-vm"
  shape               = "VM.Standard.A1.Flex"

  shape_config {
    ocpus         = 2
    memory_in_gbs = 12
  }

  source_details {
    source_type = "image"
    source_id   = var.image_ocid
  }

  create_vnic_details {
    subnet_id        = oci_core_subnet.public.id
    assign_public_ip = true
    hostname_label   = "cluba1"
  }

  metadata = {
    ssh_authorized_keys = var.ssh_public_key
  }
}

output "public_ip" {
  value = oci_core_instance.vm.public_ip
}
