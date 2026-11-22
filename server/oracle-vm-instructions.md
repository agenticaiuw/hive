# Instructions to setup an Oracle Free VM to Run Hive

## Create Account

[Create an account here](https://www.oracle.com/cloud/sign-in.html?intcmp=OcomFreeTierPromoBanner)

You will need to connect a credit card, verify your email, and set up two factor authentication.

TODO: the free tier / trial has issues creating the ampere ARM VM (always free) with region limitations. It seems that using a pay as you go account gives better region/datacenter availability and a higher rate of success to get an always free VM provisioned without the unavailability error.

- Reference: [see conversations on this github gist](https://gist.github.com/rssnyder/51e3cfedd730e7dd5f4a816143b25dbd?permalink_comment_id=6341439)

## Create a VM Instance

TODO: investigate approach using cloud shell (and terraform) to automate provisioning using IaC.

[Navigate to the Compute Instances section of Oracle cloud dashboard](https://cloud.oracle.com/compute/instances)
Click "create instance"

Scroll down to Image, click "change image", click "Ubuntu", and scroll down and select `Canonical Ubuntu 26.04 Minimal aarch64`.

Scroll down to shape, and click "change shape".

Select "virtual machine", and "ampere", and finally `VM.Standard.A1.Flex` shape. There is a triangle to the left of that shape name. We can use 2 OCPUs and 12 GB memory completely free.

Click next, through the security section.

For networking, select "create a new virtual cloud network". From here, the defaults are sufficient for the VNIC and IP.

Next, you will need to select "paste public key" under "Add SSH Keys".

If you do not have a ssh key, you can generate one in your terminal with:

```bash
ssh-keygen
```

We recommend using a passkey for security purposes.

Then, paste your public key (the file ends in `.pub`) into the oracle cloud web interface.

Click next, and continue through the storage section with the default option for the boot volume.

Finally, select create.

You might have an issue with there not being any available VMs. You will need to be patient

## TODO: Configuration management with Ansible

The goal is that all of our VMs across the multiple club memebers' Oracle cloud accounts configured to have the same exact state (no config drift).

There's some operational friction to getting a centralized ansiblie deployment going -- mainly how do we manage secrets/API keys across multiple accounts.

Maybe we investigate how we can have different Oracle cloud accounts into a single Oracle cloud organization? Or, putting everyone's keys as secrets in some secret database... but since everyone has their credit card attatched to their (personal) accounts, we need to be highly scrutionous with our security and minimizing any attack surface, and establishing lowest possible level of trust (i.e. cloud team leads only can access keys, and multiple step approval process before any action using API keys)
