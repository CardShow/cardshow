#!/usr/bin/env python3
"""Build netlify/lib/us-zips.json from the US Census Gazetteer ZIP Code Tabulation Areas file.

  curl -O https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2024_Gazetteer/2024_Gaz_zcta_national.zip
  python3 scripts/build_us_zips.py 2024_Gaz_zcta_national.zip

Output: {"95814": [38.5803, -121.4944], ...}: the Census internal point (roughly the center) of each
ZIP Code Tabulation Area. Used by the buyer site's "near a ZIP code" search and the MCP server.
ZCTAs are close to, but not exactly, USPS ZIP codes; PO-box-only ZIPs have no point.
"""
import json, sys, zipfile

def main(path):
    z = zipfile.ZipFile(path)
    lines = z.read(z.namelist()[0]).decode('latin-1').splitlines()
    head = [h.strip() for h in lines[0].split('\t')]
    ix = {h: i for i, h in enumerate(head)}
    out = {}
    for line in lines[1:]:
        f = [c.strip() for c in line.split('\t')]
        if len(f) < len(head):
            continue
        out[f[ix['GEOID']]] = [round(float(f[ix['INTPTLAT']]), 3), round(float(f[ix['INTPTLONG']]), 3)]
    json.dump(dict(sorted(out.items())), open('netlify/lib/us-zips.json', 'w'), separators=(',', ':'))
    print(len(out), 'ZIP codes')

if __name__ == '__main__':
    main(sys.argv[1])
