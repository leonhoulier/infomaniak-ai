import copy
import importlib.util
from pathlib import Path
import unittest

spec=importlib.util.spec_from_file_location("catalogue",Path(__file__).parents[1]/"scripts/sync-catalogue.py")
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
def page():
    return {"props":{"navigation":{"Test":{"items":[
      {"method":"get","endpoint":"/1/test","summary":"List"},
      {"method":"post","endpoint":"/1/test","summary":"Create"}],
      "sub_categories":{"Hidden":{"staff":True,"items":[{"method":"delete","endpoint":"/1/private"}]}}}}}}
class CatalogueTests(unittest.TestCase):
    def test_staff_and_ancestor_staff_are_excluded(self):
        data=page();data["props"]["navigation"]["Test"]["items"].append({"method":"delete","endpoint":"/1/hidden","staff":True})
        result=module.catalogue(data,"2026-10-20")
        self.assertEqual(len(result["operations"]),2)
        self.assertFalse(any("private" in r["path"] or "hidden" in r["path"] for r in result["operations"]))
    def test_route_identity_and_digest_are_deterministic(self):
        data=page();other=copy.deepcopy(data)
        other["props"]["navigation"]["Test"]["items"].reverse()
        self.assertEqual(module.catalogue(data,"2026-10-20"),module.catalogue(other,"2026-10-20"))
        rows=module.catalogue(data,"2026-10-20")["operations"]
        self.assertNotEqual(rows[0]["id"],rows[1]["id"])
    def test_conflicts_and_unknown_methods_fail_closed(self):
        data=page();data["props"]["navigation"]["Test"]["items"].append({"method":"get","endpoint":"/1/test","summary":"Different"})
        with self.assertRaises(ValueError):module.catalogue(data,"2026-10-20")
        data=page();data["props"]["navigation"]["Test"]["items"][0]["method"]="execute"
        with self.assertRaises(ValueError):module.catalogue(data,"2026-10-20")
