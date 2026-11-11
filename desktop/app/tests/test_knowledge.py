"""The knowledge base's rules, without the cloud: what counts as the same fact, what is never
stored, how saves wait while offline, and that the agent's logs never get the facts' values."""
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "python"))

import knowledge  # noqa: E402


def fact(subject, attribute, value, source="test", **extra):
    good, why = knowledge.checked(dict(subject=subject, attribute=attribute, value=value, source=source, **extra))
    assert why is None, why
    return good


class SameFact(unittest.TestCase):
    def test_a_phone_number_however_written(self):
        self.assertEqual(knowledge.value_key("(608) 555-0100"), "tel:6085550100")
        self.assertEqual(knowledge.value_key("+1 608-555-0100"), "tel:6085550100")
        stored = dict(fact("owner", "phone number", "608-555-0100"), id=1)
        self.assertTrue(knowledge.same_fact(stored, fact("me", "mobile", "(608) 555 0100")))
        self.assertTrue(knowledge.same_fact(stored, fact("owner", "cell", "+1 608 555 0100")))

    def test_an_email_or_address_under_another_attribute_name(self):
        stored = dict(fact("Test Person", "school email", "Test.Person@Example.edu"), id=1)
        self.assertTrue(knowledge.same_fact(stored, fact("test person", "email", "test.person@example.edu")))
        self.assertEqual(knowledge.value_key("https://www.example.com/"), "url:example.com")

    def test_ordinary_values_need_the_same_attribute(self):
        stored = dict(fact("owner", "likes coffee", "yes"), id=1)
        self.assertFalse(knowledge.same_fact(stored, fact("owner", "has a car", "yes")))
        self.assertTrue(knowledge.same_fact(stored, fact("owner", "Likes coffee", "Yes.")))


class NeverStored(unittest.TestCase):
    def test_secrets_are_refused(self):
        for attribute, value in [("password", "hunter2"), ("Duo passcode", "123456"), ("API key", "abc"),
                                 ("note", "4111 1111 1111 1111"), ("note", "123-45-6789"),
                                 ("note", "sk-abcdefghijklmnop1234"), ("note", "ghp_" + "a1" * 15)]:
            _, why = knowledge.checked(dict(subject="owner", attribute=attribute, value=value, source="test"))
            self.assertIsNotNone(why, (attribute, value))

    def test_ordinary_personal_facts_are_kept(self):
        for attribute, value in [("student ID number", "9081234567"), ("school email", "a@example.edu"),
                                 ("address", "123 Main St"), ("phone number", "608-555-0100")]:
            _, why = knowledge.checked(dict(subject="owner", attribute=attribute, value=value, source="test"))
            self.assertIsNone(why, (attribute, value))

    def test_a_fact_needs_a_source(self):
        _, why = knowledge.checked(dict(subject="owner", attribute="name", value="X"))
        self.assertIn("source", why)


class Offline(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.folder, self.query = knowledge.folder, knowledge.query
        knowledge.folder = lambda: Path(self.dir.name)

        def unreachable(statements):
            raise knowledge.Offline("no network")
        knowledge.query = unreachable

    def tearDown(self):
        knowledge.folder, knowledge.query = self.folder, self.query
        self.dir.cleanup()

    def test_a_save_waits_on_the_mac_and_a_known_fact_is_not_queued(self):
        knowledge._write_cache([dict(fact("owner", "phone number", "608-555-0100"), id=4, learned_at="2026-11-11")])
        report = knowledge.save([dict(subject="owner", attribute="mobile", value="(608) 555-0100", source="x"),
                                 dict(subject="Club", attribute="room", value="1240", source="x")])
        self.assertEqual(len(report["already"]), 1)
        self.assertEqual(report["queued"], ["Club · room"])
        self.assertEqual([f["subject"] for f in knowledge._pending()], ["Club"])

    def test_a_lookup_answers_from_the_macs_copy(self):
        knowledge._write_cache([dict(fact("Club", "meeting room", "Room 1240"), id=1, learned_at="2026-11-11")])
        found = knowledge.lookup("club room")
        self.assertEqual(len(found["facts"]), 1)
        self.assertIn("no network", found["offline"])
        self.assertIn("Mac's copy", knowledge.lookup_text(found, {}))


class AgentCalls(unittest.TestCase):
    def test_batch_steps_reach_the_knowledge_base(self):
        self.assertTrue(knowledge.is_call("mac", "batch", {"steps": [{"tool": "knowledge_lookup", "query": "x"}]}))
        self.assertFalse(knowledge.is_call("mac", "batch", {"steps": [{"tool": "click", "x": 1, "y": 2}]}))
        result, _ = knowledge.call("mac", "batch", {"steps": [{"tool": "knowledge_lookup"}, {"tool": "click"}]})
        self.assertTrue(result["isError"])

    def test_the_log_line_never_has_the_value(self):
        shown = knowledge.describe("mac", "batch", {"steps": [{"tool": "knowledge_save", "facts": [
            {"subject": "owner", "attribute": "phone number", "value": "608-555-0100", "source": "x"}]}]})
        self.assertEqual(shown, "knowledge.save(1 fact: owner · phone number)")
        self.assertNotIn("555", shown)


if __name__ == "__main__":
    unittest.main()
