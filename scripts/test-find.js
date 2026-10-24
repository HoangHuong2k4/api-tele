const desc = "7YFAXJXRYW5J GD 6204TPBVI2MCVK22 230726-13:00:17";
const codes = new Set(["7YFAXJXRYW5J"]);

function findPaymentCode(desc, codes) {
    const legacy = desc.match(/(nap|mua)[\s-]?([A-Z0-9]{6,12})/i);
    if (legacy) {
        const code = legacy[2].toUpperCase();
        if (codes.has(code)) return code;
    }
    for (const token of (desc.match(/[A-Z0-9]{8,16}/gi) || [])) {
        const upper = token.toUpperCase();
        if (codes.has(upper)) return upper;
    }
    return null;
}
console.log("Matched code:", findPaymentCode(desc, codes));
