"""Credential-free authentication tools, including for older persisted conversations."""
import mac_mcp
import phone_mcp

TOOLS = []
for module, name in [(mac_mcp, 'authenticate_mac'), (phone_mcp, 'authenticate_phone')]:
    spec = next(t for t in module.TOOLS if t['name'] == 'authenticate')
    TOOLS.append(dict(spec, name=name))
TOOLS.append(next(t for t in mac_mcp.TOOLS if t['name'] == 'read_selected_text'))

class AuthenticationTools:
    def call(self, name, args):
        if name == 'authenticate_mac': return mac_mcp.MacTools().call('authenticate', args)
        if name == 'authenticate_phone': return phone_mcp.PhoneTools().call('authenticate', args)
        if name == 'read_selected_text': return mac_mcp.MacTools().call('read_selected_text', args)
        return mac_mcp.result(mac_mcp.text('Unknown authentication tool.'), error=True)

if __name__ == '__main__':
    import settings
    settings.load()
    mac_mcp.main(mac_mcp.Server(AuthenticationTools(), TOOLS, 'agent-authentication',
        'Use only for account sign-in/unlock explicitly relevant to the user task. No secrets in arguments. '
        'A failed attempt is not retried. Authentication never authorizes sending messages or making transactions.'))
