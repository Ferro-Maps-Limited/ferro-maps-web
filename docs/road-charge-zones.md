# UK road-charge zones

This importer reads zone boundaries from local files and can write them to the `road_charge_zones` collection. It is for detection and alerts. It does not store a price, a charge amount, or a tariff.

The command lives in `scripts/import-road-charge-zones`. It is off unless you pass `--input`. It does not download anything, it is not a Cloud Function, and it has no schedule. `firebase.json`, the Firestore indexes, and the security rules are unchanged. The existing catch-all rule still denies client reads and writes of `road_charge_zones`.

A write is refused unless `FIRESTORE_EMULATOR_HOST` is set and `--project` starts with `demo-`. `--allow-non-emulator` skips that check. No script, workflow, or config in this repo passes it. `--include-osm-gates` is a second switch, also off unless you pass it, for the optional OpenStreetMap toll gates.

Firestore cannot store a nested array, and a GeoJSON polygon is one. The document field `geometry` is the GeoJSON geometry as a string. The other fields are `id`, `name`, `kind`, `sourceUrl`, `licence`, `attribution`, and `fetchedAt`. `kind` is one of `congestion`, `ulez`, `toll`, `caz`, `tunnel`, or `gate`.

Put downloaded files in one directory and use these names:

| File | Source |
| --- | --- |
| `tfl-congestion-charge.geojson` | TfL Congestion Charge, WGS84 GeoJSON |
| `london-wide-ulez.geojson` | London Datastore ULEZ GeoJSON (British National Grid) |
| `birmingham-caz.geojson` | Birmingham Clean Air Zone, WGS84 GeoJSON |
| `weca-caz.geojson` | West of England Clean Air Zones GeoJSON |
| `govuk-caz-list.html` | GOV.UK Clean Air Zone list |
| `govuk-toll-roads.html` | GOV.UK toll-road list |
| `osm-gates.json` | OpenStreetMap, only with `--include-osm-gates` |

Any other file in the directory is ignored. Tests use the small files in `fixtures/` and do not contact the network.

```
cd scripts/import-road-charge-zones
npm test
node --import tsx import.ts --input ./fixtures --fetched-at 2026-01-15T12:00:00.000Z
```

A dry run prints the summary and writes nothing. To write to the emulator:

```
FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 \
  node --import tsx import.ts --input ./downloads --write --project demo-ferromaps-zones
```

The write path loads `firebase-admin` only after the emulator check. Install it in this directory before a real emulator write. A refused write does not load it.

The London Datastore ULEZ file is EPSG:27700. The parser converts it to WGS84 with the Ordnance Survey Helmert approximation, not the OSTN15 grid, so a vertex can be a few metres off the deposited plan.

## Sources

Checked November 2026. A source is imported only when the publisher states a licence that allows reuse and the file contains a boundary. Where the licence does not allow reuse, or it is unclear, the source is left out.

| Source | URL | Licence | Decision |
| --- | --- | --- | --- |
| TfL Congestion Charge boundary | https://gis-tfl.opendata.arcgis.com/datasets/congestion-charge-zone | Open Government Licence v3.0. The dataset item says "Open data under Open Government Licence v3" and links to https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/. The hub at https://gis-tfl.opendata.arcgis.com/ says data on that platform is under the OGL unless a dataset says otherwise, and is used with the Transport Data Service terms at https://tfl.gov.uk/corporate/terms-and-conditions/transport-data-service. The hub also carries "© Crown Copyright and Database Rights 2023 Ordnance Survey 100035971". The service copyright is Transport for London. | Imported as `uk-lon-congestion-charge`. Both published polygons are kept. Download WGS84 GeoJSON from https://services1.arcgis.com/YswvgzOodUvqkoCN/arcgis/rest/services/Congestion_Charge_Zone/FeatureServer/8/query?where=1%3D1&outFields=OBJECTID,BOUNDARY,DESCRIPTIO&outSR=4326&f=geojson |
| London-wide ULEZ | https://data.london.gov.uk/dataset/london-wide-ultra-low-emission-zone-2023-vd455 | Open Government Licence v2.0. The dataset page states that licence and links to https://www.nationalarchives.gov.uk/doc/open-government-licence/version/2/. Publisher is the Greater London Authority. Author is TfL. | Imported as `uk-lon-ulez`. Download https://data.london.gov.uk/download/vd455/0cab9a8b-ca8a-47b0-aaf8-0e77a9041a19/LondonWideUltraLowEmissionZone.geojson . The file's own attribute says "Low Emission Zone" because the London-wide ULEZ uses that boundary. The record stays the ULEZ dataset. |
| Birmingham Clean Air Zone | https://www.arcgis.com/home/item.html?id=8237dda7cea74bce89a32893a455845f | Open Government Licence v3.0. The ArcGIS item links to the OGL v3.0 page. The layer copyright text is Birmingham City Council. Transport for West Midlands publishes the service. | Imported as `uk-bir-caz`. Download https://maps.tfwm.org.uk/server/rest/services/Hosted/Clean_Air_Zone/FeatureServer/0/query?where=1%3D1&outFields=*&outSR=4326&f=geojson . The council map server at maps.birmingham.gov.uk has an empty copyright line, so that endpoint is not used. |
| Bristol Clean Air Zone | https://opendata.westofengland-ca.gov.uk/explore/assets/weca_caz/ | Open Government Licence v3.0. The dataset metadata says "OGL v.3" and its licence URL is the OGL v3.0 page. Publisher is the West of England Combined Authority. Attributions name Bristol City Council and Bath and North East Somerset Council. | Bristol is imported as `uk-brs-caz`. Bath is in the same file and is not imported. Download https://opendata.westofengland-ca.gov.uk/api/explore/v2.1/catalog/datasets/weca_caz/exports/geojson |
| GOV.UK Clean Air Zone list | https://www.gov.uk/guidance/driving-in-a-clean-air-zone | Open Government Licence v3.0. The GOV.UK footer states that licence. | Parsed, not written as a geometry. The page lists Bath, Birmingham, Bradford, Bristol, Portsmouth, Sheffield, and Tyneside (Newcastle and Gateshead), with a class and an area in square miles. It does not publish a boundary. Birmingham and Bristol boundaries are written only when this list names them. The other cities are reported and not given an invented shape. The page mentions a £5,000 payment limit. That amount is ignored. |
| Dartford Crossing, M6 Toll, Mersey Gateway, Tyne Tunnels, Humber Bridge | https://www.gov.uk/uk-toll-roads and the Dartford page https://www.gov.uk/pay-dartford-crossing-charge | Open Government Licence v3.0, from the GOV.UK footer. | Parsed from the toll-road list, not written. The page names each crossing and a town. It does not publish coordinates. The location links are Google Maps, and those coordinates are not read. The Dartford detail page does not publish a boundary either. Prices on either page are not read. |
| Blackwall Tunnel and Silvertown Tunnel | https://tfl.gov.uk/modes/driving/silvertown-blackwall-tunnels-charge/blackwall-and-silvertown-tunnels-where-and-when | Not reused. | Left out. The GIS hub does not publish a boundary for these tunnels. The charge page offers a PDF and a GIF. Those are website files, not a dataset covered by the hub's OGL statement. |
| M6 Toll operator | https://www.m6toll.co.uk/ | The site is marked © M6toll and does not offer an open licence. | Left out. The GOV.UK name is parsed and not written, as above. |
| Mersey Gateway operator | https://www.merseyflow.co.uk/ | The site says all rights reserved. | Left out. |
| Tyne Tunnels operator | https://www.tt2.co.uk/ | No open licence is stated on the pages that loaded. | Left out. |
| Humber Bridge operator | https://www.humberbridge.co.uk/ | The site returned HTTP 403, so the licence is unclear. | Left out. |
| Heathrow terminal drop-off | https://www.heathrow.com/transport-and-directions/terminal-drop-off-charge and the terms at https://www.heathrow.com/terms-and-conditions | The terms say the website material may not be copied without prior written permission. No official open boundary was found. | Left out. |
| Toll gates | https://www.openstreetmap.org/copyright | Open Database Licence (ODbL) 1.0, https://opendatacommons.org/licenses/odbl/1-0/ | Optional and off. Pass `--include-osm-gates` to parse a local Overpass file of `barrier=toll_booth` nodes. Every gate is stored with "© OpenStreetMap contributors". Fee tags are not copied. |

Each imported record carries that row's source URL, licence, and attribution, plus the `fetchedAt` time you pass in.
