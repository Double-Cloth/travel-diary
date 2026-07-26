import { writeFile } from 'node:fs/promises';

const CLDR_VERSION = '48.2.1';
const CLDR_BASE_URL = `https://raw.githubusercontent.com/unicode-org/cldr-json/${CLDR_VERSION}/cldr-json`;
const SOURCE_URLS = {
    namesZh: `${CLDR_BASE_URL}/cldr-localenames-full/main/zh-Hans/territories.json`,
    namesEn: `${CLDR_BASE_URL}/cldr-localenames-full/main/en/territories.json`,
    territoryInfo: `${CLDR_BASE_URL}/cldr-core/supplemental/territoryInfo.json`,
    codeMappings: `${CLDR_BASE_URL}/cldr-core/supplemental/codeMappings.json`
};
const OUTPUT_URL = new URL('../data/countries.json', import.meta.url);

// CLDR 还包含部分保留代码和自定义区域；这里保留 ISO 3166-1 正式分配的 249 项。
const CLDR_NON_ISO_REGIONS = new Set(['AC', 'CP', 'CQ', 'DG', 'EA', 'IC', 'TA', 'XK', 'ZZ']);
const DEFAULT_ADMIN_AREA = Object.freeze({
    label: '一级行政区',
    option: '州 / 省 / 地区'
});

// 只对称谓稳定且常用的国家进行本地化；其余国家安全回退为“一级行政区”。
const ADMIN_AREA_OVERRIDES = Object.freeze({
    AD: '堂区',
    AE: '酋长国',
    AF: '省',
    AG: '堂区 / 属地',
    AL: '州',
    AM: '州',
    AO: '省',
    AR: '省 / 自治市',
    AT: '州',
    AU: '州 / 领地',
    BA: '实体 / 特区',
    BD: '专区',
    BE: '大区 / 社群',
    BF: '大区',
    BG: '州',
    BH: '省',
    BI: '省',
    BJ: '省',
    BO: '省',
    BR: '州 / 联邦区',
    BS: '区',
    BT: '宗',
    BW: '区',
    BY: '州 / 首都',
    BZ: '区',
    CA: '省 / 地区',
    CD: '省',
    CF: '省 / 经济州',
    CG: '省',
    CH: '州',
    CI: '区 / 自治区',
    CL: '大区',
    CM: '大区',
    CN: {
        label: '省级行政区',
        option: '省 / 自治区 / 直辖市'
    },
    CO: '省 / 首都区',
    CR: '省',
    CU: '省 / 特区',
    CV: '县',
    CY: '区',
    CZ: '州 / 首都',
    DE: '联邦州',
    DJ: '大区 / 市',
    DK: '大区',
    DO: '省 / 国家区',
    DZ: '省',
    EC: '省',
    EE: '县',
    EG: '省',
    ER: '区',
    ES: '自治区',
    ET: '州 / 特许市',
    FI: '大区',
    FJ: '区',
    FM: '州',
    FR: '大区 / 海外区域',
    GA: '省',
    GB: '构成国 / 地区',
    GE: '大区 / 自治共和国',
    GH: '大区',
    GM: '大区 / 市',
    GN: '大区 / 特区',
    GQ: '省',
    GR: '大区',
    GT: '省',
    GW: '大区 / 自治区',
    GY: '大区',
    HN: '省',
    HR: '县 / 市',
    HT: '省',
    HU: '州 / 首都',
    ID: '省',
    IE: '省 / 郡',
    IL: '区',
    IN: '邦 / 中央直辖区',
    IQ: '省',
    IR: '省',
    IS: '大区',
    IT: '大区',
    JM: '堂区',
    JO: '省',
    JP: '都道府县',
    KE: '县',
    KG: '州 / 直辖市',
    KH: '省 / 自治市',
    KI: '群岛 / 委员会',
    KM: '岛',
    KN: '堂区',
    KP: '道 / 直辖市',
    KR: '道 / 广域市',
    KW: '省',
    KZ: '州 / 直辖市',
    LA: '省 / 首都',
    LB: '省',
    LC: '区',
    LI: '市镇',
    LK: '省',
    LR: '县',
    LS: '区',
    LT: '县',
    LU: '县',
    LV: '市镇 / 国家级城市',
    LY: '区',
    MA: '大区',
    MD: '区 / 市 / 自治单位',
    ME: '市镇',
    MG: '大区',
    MH: '市镇',
    MK: '市镇',
    ML: '大区 / 首都区',
    MM: '省 / 邦 / 联邦区',
    MN: '省 / 首都',
    MR: '大区',
    MT: '大区',
    MU: '区 / 属地',
    MV: '环礁 / 市',
    MW: '大区',
    MX: '州 / 联邦实体',
    MY: '州 / 联邦直辖区',
    MZ: '省',
    NA: '大区',
    NE: '大区 / 首都区',
    NG: '州 / 首都区',
    NI: '省 / 自治区',
    NL: '构成国 / 省',
    NO: '郡',
    NP: '省',
    NR: '区',
    NZ: '大区 / 单一管理区',
    OM: '省',
    PA: '省 / 原住民区',
    PE: '大区 / 特别区',
    PG: '省 / 自治区',
    PH: '大区',
    PK: '省 / 地区',
    PL: '省',
    PS: '省',
    PT: '区 / 自治区',
    PW: '州',
    PY: '省 / 首都区',
    QA: '市镇',
    RO: '县 / 直辖市',
    RS: '区 / 自治省',
    RU: '联邦主体',
    RW: '省 / 市',
    SA: '省',
    SB: '省',
    SC: '区',
    SD: '州',
    SE: '省',
    SG: '地区',
    SI: '市镇',
    SK: '州',
    SL: '省 / 地区',
    SM: '堡',
    SN: '大区',
    SO: '联邦成员州 / 地区',
    SR: '区',
    SS: '州 / 行政区',
    ST: '省 / 自治区',
    SV: '省',
    SY: '省',
    SZ: '区',
    TD: '省',
    TG: '大区',
    TH: '府',
    TJ: '州 / 自治州',
    TL: '市',
    TM: '州 / 首都',
    TN: '省',
    TO: '区',
    TR: '省',
    TT: '大区 / 自治市',
    TV: '岛屿委员会',
    TW: '直辖市 / 县 / 市',
    TZ: '大区',
    UA: '州 / 自治共和国',
    UG: '大区 / 区',
    US: '州 / 特区',
    UY: '省',
    UZ: '州 / 自治共和国',
    VC: '堂区',
    VE: '州 / 首都区',
    VN: '省 / 直辖市',
    VU: '省',
    WS: '区',
    YE: '省 / 直辖市',
    ZA: '省',
    ZM: '省',
    ZW: '省 / 直辖市'
});

const ADMIN_AREA_OPTIONAL = new Set([
    'AQ', 'BV', 'CC', 'CX', 'GI', 'GS', 'HM', 'IO', 'MC', 'NF', 'PN', 'SG', 'SJ', 'TF', 'TK', 'UM', 'VA'
]);
const EXTRA_ALIASES = Object.freeze({
    CN: ['中华人民共和国', 'PRC'],
    GB: ['UK', 'Great Britain'],
    KP: ['North Korea'],
    KR: ['Korea'],
    RU: ['Russian Federation'],
    US: ['USA']
});

const [zhData, enData, territoryInfoData, codeMappingsData] = await Promise.all(
    Object.values(SOURCE_URLS).map(fetchJson)
);
const zhTerritories = zhData.main['zh-Hans'].localeDisplayNames.territories;
const enTerritories = enData.main.en.localeDisplayNames.territories;
const territoryCodes = Object.keys(territoryInfoData.supplemental.territoryInfo)
    .filter(code => /^[A-Z]{2}$/.test(code) && !CLDR_NON_ISO_REGIONS.has(code))
    .sort();
const codeMappings = codeMappingsData.supplemental.codeMappings;

if (territoryCodes.length !== 249) {
    throw new Error(`Expected 249 ISO 3166-1 entries, received ${territoryCodes.length}.`);
}

const countries = territoryCodes.map((code) => {
    const mapping = codeMappings[code];
    const nameZh = zhTerritories[code];
    const nameEn = enTerritories[code];

    if (!mapping?._alpha3 || !mapping?._numeric || !nameZh || !nameEn) {
        throw new Error(`Incomplete country metadata for ${code}.`);
    }

    const adminArea = normalizeAdminArea(ADMIN_AREA_OVERRIDES[code]);

    return {
        code,
        alpha3: mapping._alpha3,
        numeric: mapping._numeric,
        name_zh: nameZh,
        name_en: nameEn,
        aliases: collectAliases(code, zhTerritories, enTerritories),
        admin_area_label: adminArea.label,
        admin_area_option: adminArea.option,
        admin_area_optional: ADMIN_AREA_OPTIONAL.has(code),
        domestic: code === 'CN'
    };
});

const catalog = {
    schema_version: 1,
    standard: 'ISO 3166-1',
    locale: 'zh-Hans',
    country_count: countries.length,
    source: {
        code_standard: 'ISO 3166-1',
        localized_names: `Unicode CLDR ${CLDR_VERSION}`,
        license: 'Unicode License V3',
        urls: SOURCE_URLS
    },
    defaults: {
        admin_area_label: DEFAULT_ADMIN_AREA.label,
        admin_area_option: DEFAULT_ADMIN_AREA.option,
        locality_label: '城市 / 目的地'
    },
    countries
};

await writeFile(OUTPUT_URL, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');
console.log(`Generated ${countries.length} countries at ${OUTPUT_URL.pathname}`);

async function fetchJson(url) {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Failed to fetch ${url} (${response.status}).`);
    }

    return response.json();
}

function normalizeAdminArea(value) {
    if (!value) return DEFAULT_ADMIN_AREA;
    if (typeof value === 'string') return { label: value, option: value };

    return {
        label: value.label || DEFAULT_ADMIN_AREA.label,
        option: value.option || value.label || DEFAULT_ADMIN_AREA.option
    };
}

function collectAliases(code, ...territorySets) {
    const names = new Set(EXTRA_ALIASES[code] || []);

    territorySets.forEach((territories) => {
        Object.entries(territories)
            .filter(([key, value]) => key.startsWith(`${code}-alt-`) && value && value !== code)
            .forEach(([, value]) => names.add(value));
    });

    return Array.from(names).sort((a, b) => a.localeCompare(b, 'zh-CN'));
}
