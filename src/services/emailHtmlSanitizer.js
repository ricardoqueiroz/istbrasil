import sanitizeHtml from 'sanitize-html';

const ALLOWED_TAGS = [
    'p', 'br', 'strong', 'em', 'b', 'i', 'u', 's', 'a', 'img',
    'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'span', 'div', 'ul', 'ol', 'li'
];

const ALLOWED_ATTRIBUTES = {
    a: ['href', 'title', 'target'],
    img: ['src', 'alt', 'title', 'width', 'height'],
    table: ['width', 'border', 'cellpadding', 'cellspacing'],
    th: ['colspan', 'rowspan', 'scope'],
    td: ['colspan', 'rowspan'],
    '*': ['style']
};

const SAFE_CSS_VALUE = /^(?!.*(?:url|expression|javascript|vbscript|data\s*:))[#(),.%\w\s-]+$/i;
const ALLOWED_STYLE_PROPERTIES = [
    'color', 'background-color', 'font-family', 'font-size', 'font-weight', 'font-style',
    'text-decoration', 'text-align', 'line-height', 'margin', 'margin-top', 'margin-right',
    'margin-bottom', 'margin-left', 'padding', 'padding-top', 'padding-right',
    'padding-bottom', 'padding-left', 'border', 'border-collapse', 'width', 'height',
    'max-width', 'vertical-align'
];

const allowedStyles = {
    '*': Object.fromEntries(ALLOWED_STYLE_PROPERTIES.map((property) => [property, [SAFE_CSS_VALUE]]))
};

export const sanitizeEmailHtml = (html) => sanitizeHtml(html, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: ALLOWED_ATTRIBUTES,
    allowedStyles,
    allowedSchemes: ['http', 'https', 'mailto'],
    allowedSchemesByTag: {
        a: ['http', 'https', 'mailto'],
        img: ['http', 'https']
    },
    allowProtocolRelative: false,
    enforceHtmlBoundary: true
});
