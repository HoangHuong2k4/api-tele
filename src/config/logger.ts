import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import path from 'path';

const logFormat = winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.printf(({ timestamp, level, message }) => {
        return `[${timestamp}] ${level.toUpperCase()}: ${message}`;
    })
);

const logger = winston.createLogger({
    format: logFormat,
    transports: [
        // Log ra console
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                logFormat
            )
        }),
        // Lưu log giao dịch & lỗi vào file, xoay vòng mỗi ngày
        new DailyRotateFile({
            filename: path.join(__dirname, '../../logs/application-%DATE%.log'),
            datePattern: 'YYYY-MM-DD',
            zippedArchive: true,
            maxSize: '20m',
            maxFiles: '14d',
            level: 'info'
        }),
        // Riêng log lỗi
        new DailyRotateFile({
            filename: path.join(__dirname, '../../logs/error-%DATE%.log'),
            datePattern: 'YYYY-MM-DD',
            zippedArchive: true,
            maxSize: '20m',
            maxFiles: '30d',
            level: 'error'
        })
    ]
});

export default logger;
