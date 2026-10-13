"""A dependency-free RED gate for the new backend namespace contract."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


class NamespaceContractTests(unittest.TestCase):
    def test_required_agent_and_tenant_namespace(self):
        from cagent_backend.knowledge import KnowledgeError, Namespace

        self.assertEqual(Namespace("local", "assistant", "notes").agent_id, "assistant")
        with self.assertRaises(KnowledgeError):
            Namespace("", "assistant", "notes")


if __name__ == "__main__":
    unittest.main()
