import copy
import datetime as dt
import hashlib
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from check_evidence import validate


class MaintenanceEvidenceTest(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.root=Path(self.temp.name).resolve()
        (self.root/'proof.json').write_text('{"syntheticTest":true}')
        self.row={'id':'test-only','kind':'local','status':'passed','exitCode':0,
                  'independentUser':False,'providerCalls':0,'version':'synthetic-fixture',
                  'observedAt':(dt.datetime.now(dt.timezone.utc)-dt.timedelta(minutes=1)).isoformat(),
                  'evidence':[{'path':'proof.json','sha256':hashlib.sha256((self.root/'proof.json').read_bytes()).hexdigest()}]}

    def tearDown(self):
        self.temp.cleanup()

    def check(self,row=None):
        return validate({'schemaVersion':1,'records':[self.row if row is None else row]},self.root)

    def test_valid_local_proof_never_establishes_grant_eligibility(self):
        result=self.check()
        self.assertEqual(result['status'],'STRUCTURALLY_VERIFIED')
        self.assertFalse(result['grantEligibilityEstablished'])

    def test_failed_run_is_preserved_without_counting_it_as_passed(self):
        row=dict(self.row,status='failed',exitCode=1)
        self.assertEqual(self.check(row)['passed'],0)

    def test_modified_evidence_is_rejected(self):
        (self.root/'proof.json').write_text('changed')
        with self.assertRaises(ValueError): self.check()

    def test_absolute_and_parent_escape_paths_rejected(self):
        for path in ('../proof.json',str(self.root/'proof.json')):
            row=copy.deepcopy(self.row)
            row['evidence'][0]['path']=path
            with self.assertRaises(ValueError): self.check(row)

    def test_direct_and_parent_symlinks_rejected(self):
        (self.root/'link').symlink_to(self.root/'proof.json')
        (self.root/'parent-link').symlink_to(self.root,target_is_directory=True)
        for path in ('link','parent-link/proof.json'):
            row=copy.deepcopy(self.row)
            row['evidence'][0]['path']=path
            with self.assertRaises(ValueError): self.check(row)

    def test_future_and_timezone_free_dates_rejected(self):
        for stamp in ('2099-01-01T00:00:00+00:00','2026-01-01T00:00:00'):
            with self.assertRaises(ValueError): self.check(dict(self.row,observedAt=stamp))

    def test_duplicate_record_ids_rejected(self):
        with self.assertRaises(ValueError): validate({'schemaVersion':1,'records':[self.row,self.row]},self.root)

    def test_outcome_and_exit_code_must_agree(self):
        with self.assertRaises(ValueError): self.check(dict(self.row,exitCode=1))
        with self.assertRaises(ValueError): self.check(dict(self.row,exitCode=True))

    def test_call_count_cannot_be_boolean_negative_or_unknown(self):
        for count in (True,-1,None):
            with self.assertRaises(ValueError): self.check(dict(self.row,providerCalls=count))

    def test_public_url_is_not_treated_as_a_fetched_observation(self):
        with self.assertRaises(ValueError): self.check(dict(self.row,kind='public'))
        result=self.check(dict(self.row,kind='public',publicURL='https://github.com/example/project/issues/1'))
        self.assertFalse(result['publicURLsFetched'])

    def test_proof_and_version_are_required(self):
        with self.assertRaises(ValueError): self.check(dict(self.row,evidence=[]))
        with self.assertRaises(ValueError): self.check(dict(self.row,version=''))

    def test_empty_records_do_not_produce_a_valid_certificate(self):
        with self.assertRaises(ValueError): validate({'schemaVersion':1,'records':[]},self.root)


if __name__ == '__main__':
    unittest.main()
