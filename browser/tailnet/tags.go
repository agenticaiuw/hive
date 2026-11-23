//go:build ignore

// Prints the build tags that leave out every Tailscale feature a browser node doesn't use, as tsconnect's own build does,
// keeping the baked-in Let's Encrypt roots that .ts.net certificates are verified with.
package main

import (
	"fmt"
	"strings"

	"tailscale.com/feature/featuretags"
)

func main() {
	fmt.Println(strings.Join(featuretags.MinTags("c2n", "dns", "health", "ipnbus", "netstack", "bakedroots"), ","))
}
