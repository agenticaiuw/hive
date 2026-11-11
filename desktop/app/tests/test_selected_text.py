"""Selection is returned intact, and errors do not fall back to clipboard contents."""
import os, subprocess, sys, unittest
from unittest.mock import patch
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'python'))
import mac_mcp

class SelectionTest(unittest.TestCase):
    def test_whole_selection_goes_to_tool_result(self):
        selected = 'Selected words. ' * 10_000
        tool = mac_mcp.MacTools()
        with patch('mac_mcp.subprocess.run', return_value=subprocess.CompletedProcess([], 0, selected, '')):
            result = tool.call('read_selected_text', {})
        self.assertFalse(result['isError'])
        self.assertEqual(result['content'][0]['text'], selected)

    def test_inaccessible_selection_is_an_error(self):
        tool = mac_mcp.MacTools()
        with patch('mac_mcp.subprocess.run', return_value=subprocess.CompletedProcess([], 1, '', 'Selection unavailable')):
            result = tool.call('read_selected_text', {})
        self.assertTrue(result['isError'])
        self.assertIn('Selection unavailable', result['content'][0]['text'])

if __name__ == '__main__': unittest.main()
