"""One updater per installation, including recovery from a terminated process."""
import json
import os
from pathlib import Path

from release_protocol import atomic_json


class UpdateLock:
    def __init__(self, root):
        self.path = Path(root) / 'private/update-fagoo.lock'
        self.owner = self.path / 'owner.json'

    def acquire(self):
        try:
            self.path.mkdir(mode=0o700)
        except FileExistsError:
            try:
                value = json.loads(self.owner.read_text())
                pid = value['pid']
                if value.get('kind') != 'dashboard-updater' or type(pid) is not int or pid < 1:
                    raise ValueError('UPDATE_LOCK_REQUIRES_INSPECTION')
                try:
                    os.kill(pid, 0)
                except ProcessLookupError:
                    self.owner.unlink()
                    self.path.rmdir()
                    self.path.mkdir(mode=0o700)
                else:
                    raise ValueError('UPDATE_BUSY')
            except (OSError, KeyError, json.JSONDecodeError):
                raise ValueError('UPDATE_LOCK_REQUIRES_INSPECTION') from None
        atomic_json(self.owner, {'kind': 'dashboard-updater', 'pid': os.getpid()})

    def release(self):
        self.owner.unlink()
        self.path.rmdir()
