import argparse
import datetime as dt
import hashlib
import json
from pathlib import Path
import re


def validate(packet, root):
    if packet.get('schemaVersion') != 1 or not isinstance(packet.get('records'),list) or not packet['records']:
        raise ValueError('Nonempty version-1 records required')
    root = root.resolve()
    identifiers = set()
    for row in packet['records']:
        identity = row.get('id')
        if not isinstance(identity,str) or not identity.strip() or identity in identifiers:
            raise ValueError('Unique record ID required')
        identifiers.add(identity)
        if row.get('kind') not in ('local','public') or row.get('status') not in ('passed','failed'):
            raise ValueError('Explicit observation kind and outcome required')
        if row.get('kind') == 'public' and not re.fullmatch(r'https://github\.com/[^\s?#@]+',row.get('publicURL','')):
            raise ValueError('Public record needs a GitHub evidence URL')
        if row.get('independentUser') not in (True,False) or type(row.get('independentUser')) is not bool:
            raise ValueError('Independent-user classification required')
        count = row.get('providerCalls')
        if type(count) is not int or count < 0:
            raise ValueError('Nonnegative integer provider-call count required')
        if not isinstance(row.get('version'),str) or not row['version'].strip():
            raise ValueError('Observed version required')
        observed = dt.datetime.fromisoformat(row['observedAt'].replace('Z','+00:00'))
        if observed.tzinfo is None or observed > dt.datetime.now(dt.timezone.utc):
            raise ValueError('Observation must have timezone and cannot be in the future')
        code = row.get('exitCode')
        if type(code) is not int or (row['status']=='passed') != (code==0):
            raise ValueError('Outcome and command exit code disagree')
        proofs = row.get('evidence')
        if not isinstance(proofs,list) or not proofs:
            raise ValueError('Evidence files required')
        for proof in proofs:
            relative = Path(proof['path'])
            if relative.is_absolute() or '..' in relative.parts:
                raise ValueError('Evidence must stay inside the chosen root')
            path = root/relative
            if any(part.is_symlink() for part in [path,*path.parents]) or not path.resolve().is_relative_to(root) or not path.is_file():
                raise ValueError('Evidence symlink or missing file')
            if hashlib.sha256(path.read_bytes()).hexdigest() != proof.get('sha256'):
                raise ValueError('Evidence hash changed')
    return {'status':'STRUCTURALLY_VERIFIED','records':len(identifiers),
            'localRecords':sum(r['kind']=='local' for r in packet['records']),
            'passed':sum(r['status']=='passed' for r in packet['records']),
            'grantEligibilityEstablished':False,'identityVerified':False,'publicURLsFetched':False,
            'limitations':'Checks source files and declared record consistency; does not prove human independence, statement truth, publication, impact or continuous maintenance.'}


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--root',type=Path,default=Path.cwd())
    parser.add_argument('--input',type=Path,required=True)
    args=parser.parse_args()
    try:
        result=validate(json.loads(args.input.read_text()),args.root)
    except (ValueError,KeyError,TypeError,OSError,AttributeError) as error:
        print(json.dumps({'status':'INVALID','reason':str(error)}))
        return 1
    print(json.dumps(result))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
