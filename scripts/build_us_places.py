#!/usr/bin/env python3
"""Build netlify/lib/us-places.json from the US Census Gazetteer places file.

  curl -O https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2024_Gazetteer/2024_Gaz_place_national.zip
  python3 scripts/build_us_places.py 2024_Gaz_place_national.zip

Output: {"CA": {"sacramento": [38.5677, -121.4682], ...}, ...}: one point (the Census internal point,
roughly the center) per city/town/CDP, keyed by state and a normalized name. Used by geocode-shows.js
when a show has no street address, and by the MCP server's "near a city" search.
Keep the normalization in sync with placeKey() in netlify/lib/us-places.js.
"""
import json, re, sys, unicodedata, zipfile

SUFFIX = re.compile(r'\s+(city and borough|consolidated government \(balance\)|metro government \(balance\)|'
                    r'unified government \(balance\)|metropolitan government \(balance\)|\(balance\)|'
                    r'city|town|village|cdp|borough|municipality|comunidad|zona urbana|plantation|corporation|urban county)$')

def place_key(name):
    s = unicodedata.normalize('NFKD', name).encode('ascii', 'ignore').decode().lower().strip()
    for _ in range(2):
        s = SUFFIX.sub('', s).strip()
    s = re.sub(r'\bsaint\b', 'st', s)
    s = re.sub(r'\bsainte\b', 'ste', s)
    s = re.sub(r'\bfort\b', 'ft', s)
    s = re.sub(r'\bmount\b', 'mt', s)
    s = re.sub(r'[^a-z0-9]+', ' ', s).strip()
    return s

def main(path):
    z = zipfile.ZipFile(path)
    lines = z.read(z.namelist()[0]).decode('latin-1').splitlines()
    head = [h.strip() for h in lines[0].split('\t')]
    ix = {h: i for i, h in enumerate(head)}
    best = {}
    for line in lines[1:]:
        f = [c.strip() for c in line.split('\t')]
        if len(f) < len(head):
            continue
        st, name = f[ix['USPS']], f[ix['NAME']]
        key = place_key(name)
        if not key:
            continue
        rank = (1 if f[ix['FUNCSTAT']] == 'A' else 0, int(f[ix['ALAND']] or 0))
        cur = best.get((st, key))
        if cur is None or rank > cur[0]:
            best[(st, key)] = (rank, round(float(f[ix['INTPTLAT']]), 4), round(float(f[ix['INTPTLONG']]), 4))
    out = {}
    for (st, key), (_, lat, lng) in sorted(best.items()):
        out.setdefault(st, {})[key] = [lat, lng]
    json.dump(out, open('netlify/lib/us-places.json', 'w'), separators=(',', ':'))
    print(sum(len(v) for v in out.values()), 'places,', len(out), 'states')

if __name__ == '__main__':
    main(sys.argv[1])
