"""The agent says what each step does. A step that can't be undone is marked "One-way:" and has to
quote the user's own words asking for it; one that doesn't is refused before the mouse or keyboard
is touched. No list of apps or tools decides this: the agent judges each step, the quote is checked."""
import sys
from pathlib import Path
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "python"))
import agent  # noqa: E402
import mac_mcp  # noqa: E402

ASKED = ('send the backup to the general channel saying "I decided to delete the all-members channel"')


class OneWayStepTest(unittest.TestCase):
    def test_a_step_that_can_be_undone_needs_no_quote(self):
        self.assertIsNone(mac_mcp.check_step({"step": "Opening the #general channel."}, ""))
        self.assertIsNone(mac_mcp.check_step({}, ""))

    def test_a_one_way_step_quoting_the_user_goes_ahead(self):
        step = 'One-way: posting your message (you said: "send the backup to the general channel").'
        self.assertIsNone(mac_mcp.check_step({"step": step}, ASKED))
        curly = "One-way: posting it (you said: “I decided to delete the all-members channel”)."
        self.assertIsNone(mac_mcp.check_step({"step": curly}, ASKED))

    def test_a_one_way_step_without_the_users_words_is_refused(self):
        made_up = 'One-way: asking the bot (you said: "please export all-members")'
        self.assertTrue(mac_mcp.check_step({"step": made_up}, ASKED)["isError"])
        self.assertTrue(mac_mcp.check_step({"step": "One-way: sending the message."}, ASKED)["isError"])
        # A few of their words inside a longer quote of someone else's don't count.
        self.assertTrue(mac_mcp.check_step({"step": 'One-way: "general channel please"'}, ASKED)["isError"])

    def test_refused_before_the_mouse_or_keyboard_is_touched(self):
        tools = mac_mcp.MacTools.__new__(mac_mcp.MacTools)
        tools.words = ASKED
        tools.mac = mock.Mock()
        with mock.patch.object(mac_mcp, "geometry"):
            res = tools.call("press_key", {"keys": "return", "step": "One-way: sending @Badger a request."})
        self.assertTrue(res["isError"])
        tools.mac.engage.assert_not_called()
        tools.mac.key.assert_not_called()

    def test_every_action_says_what_it_does(self):
        for tool in mac_mcp.TOOLS:
            if tool["name"] in ("click", "drag", "type_text", "press_key", "batch"):
                self.assertIn("step", tool["inputSchema"]["required"], tool["name"])

    def test_the_caption_is_the_agents_own_step(self):
        item = {"tool": "click", "arguments": {"x": 1, "y": 2, "step": "Opening the #general channel."}}
        self.assertEqual(agent.doing(item), "Opening the #general channel.")
        self.assertEqual(agent.doing({"tool": "click", "arguments": {"x": 1, "y": 2}}), "Clicking")

    def test_stopping_before_a_one_way_step_counts_as_finishing(self):
        rules = " ".join(agent.RULES.split())
        self.assertIn("That is finishing the job, not failing it", rules)
        self.assertIn("written by an AI agent on the user's behalf", rules)
        self.assertNotIn("try every route", rules)


if __name__ == "__main__":
    unittest.main()
