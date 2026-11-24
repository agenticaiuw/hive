import NetworkExtension

@_silgen_name("hive_reflect_ipv4")
private func reflectIPv4(_ bytes: UnsafeMutablePointer<UInt8>, _ count: Int) -> Bool

/// A device-local route makes the phone's own developer services reachable.
/// Cloud traffic retains its normal route; this provider has no remote server.
final class PacketTunnelProvider: NEPacketTunnelProvider {
    private var active = false

    override func startTunnel(options: [String: NSObject]?, completionHandler: @escaping (Error?) -> Void) {
        let settings = NEPacketTunnelNetworkSettings(tunnelRemoteAddress: "10.7.0.1")
        let ipv4 = NEIPv4Settings(addresses: ["10.7.1.1"], subnetMasks: ["255.255.255.255"])
        ipv4.includedRoutes = [NEIPv4Route(destinationAddress: "10.7.0.1", subnetMask: "255.255.255.255")]
        ipv4.excludedRoutes = [.default()]
        settings.ipv4Settings = ipv4
        settings.mtu = 1500
        setTunnelNetworkSettings(settings) { error in
            guard error == nil else { completionHandler(error); return }
            self.active = true
            self.read()
            completionHandler(nil)
        }
    }

    override func stopTunnel(with reason: NEProviderStopReason, completionHandler: @escaping () -> Void) {
        active = false
        completionHandler()
    }

    private func read() {
        guard active else { return }
        packetFlow.readPackets { [weak self] packets, protocols in
            guard let self, self.active else { return }
            var reflected: [Data] = []
            for (index, packet) in packets.enumerated() where protocols[index].int32Value == AF_INET {
                var packet = packet
                let accepted = packet.withUnsafeMutableBytes { buffer -> Bool in
                    guard let bytes = buffer.baseAddress?.assumingMemoryBound(to: UInt8.self) else { return false }
                    return reflectIPv4(bytes, buffer.count)
                }
                if accepted { reflected.append(packet) }
            }
            if !reflected.isEmpty {
                self.packetFlow.writePackets(reflected, withProtocols: Array(repeating: NSNumber(value: AF_INET), count: reflected.count))
            }
            self.read()
        }
    }
}
