import fs from 'fs';
import path from 'path';
import logger from '../config/logger';

class I18nService {
    private locales: Record<string, Record<string, string>> = {};

    constructor() {
        this.loadLocales();
    }

    private loadLocales() {
        let dir = path.join(__dirname, '..', 'locales');
        if (!fs.existsSync(dir)) dir = path.join(process.cwd(), 'src', 'locales');

        if (!fs.existsSync(dir)) {
            logger.error(`[i18n] Locales dir not found: ${dir}`);
            return;
        }

        for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
            const lang = file.replace('.json', '');
            this.locales[lang] = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
        }
        logger.info(`[i18n] Loaded: ${Object.keys(this.locales).join(', ')}`);
    }

    public t(lang: string, key: string, params: Record<string, string | number> = {}): string {
        const code = this.locales[lang] ? lang : (this.locales['vi'] ? 'vi' : null);
        let text = (code && this.locales[code]?.[key]) || key;
        for (const [k, v] of Object.entries(params)) {
            text = text.replace(new RegExp(`{{${k}}}`, 'g'), String(v));
        }
        return text;
    }
}

export const i18n = new I18nService();
