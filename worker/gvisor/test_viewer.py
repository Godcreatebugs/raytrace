import json
import sqlite3
import unittest
from viewer import event_page

class PaginationTests(unittest.TestCase):
    def test_container_filter_precedes_limit_and_cursor(self):
        db=sqlite3.connect(':memory:')
        db.execute('CREATE TABLE runtime_events(id INTEGER PRIMARY KEY,container_id TEXT,kind TEXT,body TEXT)')
        for i in range(700):
            db.execute('INSERT INTO runtime_events VALUES(?,?,?,?)',(i+1,'target' if i<4 else 'noise','exec_succeeded',json.dumps({'kind':'exec_succeeded','raw_packet_base64':'private'})))
        first=event_page(db,{'container':['target'],'limit':['2']})
        self.assertEqual([e['event_id'] for e in first['events']],[4,3])
        self.assertNotIn('raw_packet_base64',first['events'][0])
        second=event_page(db,{'container':['target'],'limit':['2'],'before':[str(first['next_before'])]})
        self.assertEqual([e['event_id'] for e in second['events']],[2,1])
        self.assertIsNone(second['next_before'])
        db.close()

    def test_since_until_scope_a_page_to_one_turn(self):
        # The UI asks for the span of a single prompt -- from the user's
        # message to the agent's answer -- so commands from other prompts in
        # the same long-lived sandbox never appear alongside them.
        db=sqlite3.connect(':memory:')
        db.execute('CREATE TABLE runtime_events(id INTEGER PRIMARY KEY,container_id TEXT,received_ms INTEGER,kind TEXT,body TEXT)')
        for i,ms in enumerate([1000,2000,3000,4000,5000]):
            db.execute('INSERT INTO runtime_events VALUES(?,?,?,?,?)',(i+1,'box',ms,'exec_succeeded',json.dumps({'kind':'exec_succeeded'})))
        page=event_page(db,{'container':['box'],'since':['2000'],'until':['4000']})
        self.assertEqual(sorted(e['event_id'] for e in page['events']),[2,3,4])
        # Bounds are inclusive on both ends.
        edge=event_page(db,{'container':['box'],'since':['3000'],'until':['3000']})
        self.assertEqual([e['event_id'] for e in edge['events']],[3])
        # A window combines with the tailing cursor rather than replacing it.
        tailed=event_page(db,{'container':['box'],'since':['2000'],'until':['5000'],'after':['3']})
        self.assertEqual([e['event_id'] for e in tailed['events']],[4,5])
        db.close()

    def test_after_cursor_tails_oldest_first_and_reports_more(self):
        # The proxy's gVisor forwarder polls with after=<last seen id>; it
        # must get strictly newer events, oldest first, plus a hint when a
        # page was cut short by `limit` so it can keep going.
        db=sqlite3.connect(':memory:')
        db.execute('CREATE TABLE runtime_events(id INTEGER PRIMARY KEY,container_id TEXT,kind TEXT,body TEXT)')
        for i in range(6):
            db.execute('INSERT INTO runtime_events VALUES(?,?,?,?)',(i+1,'target','exec_succeeded',json.dumps({'kind':'exec_succeeded'})))
        page=event_page(db,{'container':['target'],'after':['2'],'limit':['3']})
        self.assertEqual([e['event_id'] for e in page['events']],[3,4,5])
        self.assertEqual(page['next_after'],5)
        self.assertIsNone(page['next_before'])
        rest=event_page(db,{'container':['target'],'after':[str(page['next_after'])],'limit':['3']})
        self.assertEqual([e['event_id'] for e in rest['events']],[6])
        self.assertIsNone(rest['next_after'])
        # after wins over before when both are supplied
        both=event_page(db,{'container':['target'],'after':['4'],'before':['2']})
        self.assertEqual([e['event_id'] for e in both['events']],[5,6])
        db.close()
