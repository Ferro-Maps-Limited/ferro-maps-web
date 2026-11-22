import {type ZoneKind} from "./types.ts";

export interface ZoneSource {
  id: string;
  name: string;
  kind: ZoneKind;
  sourceUrl: string;
  licence: string;
  attribution: string;
}

export const TFL_CONGESTION: ZoneSource = {
  id: "uk-lon-congestion-charge",
  name: "Central London Congestion Charging Scheme",
  kind: "congestion",
  sourceUrl: "https://gis-tfl.opendata.arcgis.com/datasets/congestion-charge-zone",
  licence: "Open Government Licence v3.0",
  attribution: "Contains Transport for London data. Open data under the Open Government Licence v3.0. Powered by TfL Open Data. © Crown Copyright and Database Rights 2023 Ordnance Survey 100035971.",
};

export const LONDON_ULEZ: ZoneSource = {
  id: "uk-lon-ulez",
  name: "London Wide Ultra Low Emission Zone 2023",
  kind: "ulez",
  sourceUrl: "https://data.london.gov.uk/dataset/london-wide-ultra-low-emission-zone-2023-vd455",
  licence: "Open Government Licence v2.0",
  attribution: "Contains Greater London Authority and Transport for London data, licensed under the Open Government Licence v2.0.",
};

export const BIRMINGHAM_CAZ: ZoneSource = {
  id: "uk-bir-caz",
  name: "Birmingham Clean Air Zone",
  kind: "caz",
  sourceUrl: "https://www.arcgis.com/home/item.html?id=8237dda7cea74bce89a32893a455845f",
  licence: "Open Government Licence v3.0",
  attribution: "Contains Birmingham City Council data, published by Transport for West Midlands, licensed under the Open Government Licence v3.0.",
};

export const BRISTOL_CAZ: ZoneSource = {
  id: "uk-brs-caz",
  name: "Bristol Clean Air Zone",
  kind: "caz",
  sourceUrl: "https://opendata.westofengland-ca.gov.uk/explore/assets/weca_caz/",
  licence: "Open Government Licence v3.0",
  attribution: "Contains Bristol City Council data, published by the West of England Combined Authority, licensed under the Open Government Licence v3.0.",
};

export const GOVUK_CAZ_LIST = {
  sourceUrl: "https://www.gov.uk/guidance/driving-in-a-clean-air-zone",
  licence: "Open Government Licence v3.0",
};

export const GOVUK_TOLL_ROADS = {
  sourceUrl: "https://www.gov.uk/uk-toll-roads",
  licence: "Open Government Licence v3.0",
};

export const OSM_GATES = {
  licence: "Open Database Licence (ODbL) 1.0",
  licenceUrl: "https://opendatacommons.org/licenses/odbl/1-0/",
  attribution: "© OpenStreetMap contributors",
  copyrightUrl: "https://www.openstreetmap.org/copyright",
};

/**
 * Sources that are not imported. The reason is the licence, or the absence
 * of an official geometry we are allowed to reuse. Kept here so the summary
 * and the tests name the same decisions as the docs.
 */
export interface ExcludedSource {
  name: string;
  url: string;
  reason: string;
}

export const EXCLUDED_SOURCES: ExcludedSource[] = [
  {
    name: "Blackwall Tunnel",
    url: "https://tfl.gov.uk/modes/driving/silvertown-blackwall-tunnels-charge/blackwall-and-silvertown-tunnels-where-and-when",
    reason: "TfL's GIS hub publishes the Congestion Charge boundary under the Open Government Licence. It does not publish a Blackwall or Silvertown boundary. The charge page only offers a PDF and a GIF. Those are website files, not a dataset on the hub, so this import does not treat them as covered by the hub licence.",
  },
  {
    name: "Silvertown Tunnel",
    url: "https://tfl.gov.uk/modes/driving/silvertown-blackwall-tunnels-charge/blackwall-and-silvertown-tunnels-where-and-when",
    reason: "Same TfL charge page as Blackwall. No hub dataset, and the downloadable map is a PDF and a GIF rather than an openly licensed geometry file.",
  },
  {
    name: "M6 Toll operator map",
    url: "https://www.m6toll.co.uk/",
    reason: "The operator site is marked © M6toll and does not offer an open licence. The GOV.UK toll-road page names the road under the Open Government Licence, but it publishes no boundary.",
  },
  {
    name: "Mersey Gateway operator map",
    url: "https://www.merseyflow.co.uk/",
    reason: "merseyflow.co.uk says all rights reserved. The GOV.UK toll-road page names the bridge under the Open Government Licence, but it publishes no boundary.",
  },
  {
    name: "Tyne Tunnels operator map",
    url: "https://www.tt2.co.uk/",
    reason: "The operator site does not state an open licence. The GOV.UK toll-road page names the tunnels under the Open Government Licence, but it publishes no boundary.",
  },
  {
    name: "Humber Bridge operator map",
    url: "https://www.humberbridge.co.uk/",
    reason: "The operator site did not return its terms (HTTP 403), so the licence is unclear. The GOV.UK toll-road page names the bridge under the Open Government Licence, but it publishes no boundary.",
  },
  {
    name: "Heathrow terminal drop-off",
    url: "https://www.heathrow.com/terms-and-conditions",
    reason: "Heathrow's terms say the website material may not be copied without prior written permission. No official open boundary was found, so Heathrow is left out.",
  },
];
