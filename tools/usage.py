"""Cloudflare usage for OrrFM, hour by hour: Worker requests and queue rows read/written.

Run: python3 tools/usage.py [hours]   (default 12; uses wrangler's login, run `npx wrangler login` if it fails)
Rows read are what the free plan capped at 5M/day; on Workers Paid 25B/month are included.
"""
import json
import pathlib
import re
import sys
import urllib.request
from datetime import datetime, timedelta, timezone

ACCOUNT = "2b188e259d3eade15c495f3543bfa576"
QUERY = """query($a:String!,$s:Time!,$e:Time!){viewer{accounts(filter:{accountTag:$a}){
 w: workersInvocationsAdaptive(limit:500, filter:{datetime_geq:$s, datetime_leq:$e, scriptName:"mattyfm"}){
   sum{requests errors} dimensions{datetimeHour} }
 p: durableObjectsPeriodicGroups(limit:500, filter:{datetime_geq:$s, datetime_leq:$e}){
   sum{rowsRead rowsWritten} dimensions{datetimeHour} }
}}}"""


def main() -> None:
    hours = int(sys.argv[1]) if len(sys.argv) > 1 else 12
    conf = pathlib.Path.home() / ".config/.wrangler/config/default.toml"
    found = re.search(r'oauth_token\s*=\s*"([^"]+)"', conf.read_text()) if conf.exists() else None
    if not found:
        sys.exit("No wrangler login found: run `cd worker && npx wrangler login`")
    token = found.group(1)
    end = datetime.now(timezone.utc)
    start = end - timedelta(hours=hours)
    body = json.dumps({"query": QUERY, "variables": {
        "a": ACCOUNT, "s": start.strftime("%Y-%m-%dT%H:00:00Z"), "e": end.strftime("%Y-%m-%dT%H:%M:%SZ")}}).encode()
    req = urllib.request.Request("https://api.cloudflare.com/client/v4/graphql", body,
                                 {"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
    r = json.load(urllib.request.urlopen(req))
    if r.get("errors"):
        sys.exit(f"Cloudflare said: {r['errors'][0].get('message')} (token expired? run `npx wrangler login`)")
    acct = r["data"]["viewer"]["accounts"][0]
    rows: dict[str, dict] = {}
    for x in acct["w"]:
        rows.setdefault(x["dimensions"]["datetimeHour"], {}).update(x["sum"])
    for x in acct["p"]:
        rows.setdefault(x["dimensions"]["datetimeHour"], {}).update(x["sum"])
    print(f"{'hour (Central)':<16}{'requests':>10}{'errors':>8}{'rows read':>12}{'written':>9}")
    total = {"requests": 0, "rowsRead": 0}
    for hour in sorted(rows):
        v = rows[hour]
        local = datetime.fromisoformat(hour.replace("Z", "+00:00")).astimezone().strftime("%a %H:00")
        print(f"{local:<16}{v.get('requests', 0):>10,}{v.get('errors', 0):>8,}{v.get('rowsRead', 0):>12,}{v.get('rowsWritten', 0):>9,}")
        for k in total:
            total[k] += v.get(k, 0)
    print(f"{'total':<16}{total['requests']:>10,}{'':>8}{total['rowsRead']:>12,}")


if __name__ == "__main__":
    main()
