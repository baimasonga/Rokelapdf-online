"""Security boundaries for the co-located services (no external services needed)."""

import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("supervise", Path(__file__).with_name("supervise.py"))
supervise = importlib.util.module_from_spec(spec)
spec.loader.exec_module(supervise)


class EnvironmentTests(unittest.TestCase):
    def test_private_services_do_not_inherit_application_credentials(self):
        source = {
            "DATABASE_URL": "synthetic-database-secret",
            "R2_SECRET_ACCESS_KEY": "synthetic-storage-secret",
            "CLAMD_HOST": "old.railway.internal",
            "CONVERTER_URL": "http://old.railway.internal",
            "CONVERTER_TOKEN": "old-token",
        }
        common, converter, app = supervise.service_environments(source)
        for settings in (common, converter):
            self.assertNotIn("DATABASE_URL", settings)
            self.assertNotIn("R2_SECRET_ACCESS_KEY", settings)
        self.assertEqual(app["CLAMD_HOST"], "127.0.0.1")
        self.assertEqual(app["CONVERTER_URL"], "http://127.0.0.1:8080")
        self.assertEqual(converter["HOST"], "127.0.0.1")
        self.assertEqual(app["CONVERTER_TOKEN"], converter["CONVERTER_TOKEN"])
        self.assertGreaterEqual(len(app["CONVERTER_TOKEN"]), 32)
        self.assertNotEqual(app["CONVERTER_TOKEN"], source["CONVERTER_TOKEN"])
        self.assertEqual(app["DATABASE_URL"], source["DATABASE_URL"])

    def test_each_start_gets_a_different_local_token(self):
        self.assertNotEqual(supervise.service_environments({})[2]["CONVERTER_TOKEN"], supervise.service_environments({})[2]["CONVERTER_TOKEN"])


if __name__ == "__main__":
    unittest.main()
