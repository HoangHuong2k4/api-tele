import { Request, Response } from 'express';
import pool from '../config/db';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const JWT_SECRET = process.env.JWT_SECRET || 'supersecretkey';

export const register = async (req: Request, res: Response) => {
    const { username, password, telegram_id } = req.body;

    if (!username || !password) {
        return res.status(400).json({ error: 'Username and password are required' });
    }

    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const apiKey = crypto.randomBytes(24).toString('hex');

        const [result]: any = await pool.execute(
            'INSERT INTO users (username, password_hash, telegram_id, api_key) VALUES (?, ?, ?, ?)',
            [username, hashedPassword, telegram_id || null, apiKey]
        );

        return res.status(201).json({
            success: true,
            message: 'User registered successfully',
            userId: result.insertId
        });
    } catch (error: any) {
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(400).json({ error: 'Username already exists' });
        }
        console.error('Registration error:', error);
        return res.status(500).json({ error: 'Internal Server Error' });
    }
};

export const login = async (req: Request, res: Response) => {
    const { username, password } = req.body;

    try {
        const [rows]: any = await pool.execute(
            'SELECT * FROM users WHERE username = ?',
            [username]
        );

        if (rows.length === 0) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        const user = rows[0];
        const isMatch = await bcrypt.compare(password, user.password_hash);

        if (!isMatch) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, {
            expiresIn: '24h'
        });

        return res.json({
            success: true,
            token,
            user: {
                id: user.id,
                username: user.username,
                balance: user.balance,
                api_key: user.api_key,
                role: user.role
            }
        });
    } catch (error) {
        console.error('Login error:', error);
        return res.status(500).json({ error: 'Internal Server Error' });
    }
};

export const getProfile = async (req: any, res: Response) => {
    try {
        const [rows]: any = await pool.execute(
            'SELECT id, username, telegram_id, balance, api_key, role FROM users WHERE id = ?',
            [req.user.id]
        );

        if (rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }

        return res.json({ success: true, user: rows[0] });
    } catch (error) {
        return res.status(500).json({ error: 'Internal Server Error' });
    }
};

export const deleteUser = async (req: Request, res: Response) => {
    const { id } = req.params;
    try {
        await pool.execute('DELETE FROM users WHERE id = ?', [id]);
        return res.json({ success: true, message: 'User deleted' });
    } catch (error) {
        return res.status(500).json({ error: 'Internal Server Error' });
    }
};
