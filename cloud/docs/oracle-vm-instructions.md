# Instructions to setup an Oracle Free VM to Run Hive

## Create Account

[Create an account here](https://www.oracle.com/cloud/sign-in.html?intcmp=OcomFreeTierPromoBanner)

You will need to connect a credit card, verify your email, and set up two factor authentication.

## Create a VM Instance

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
