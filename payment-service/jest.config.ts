import type { Config } from 'jest';

const config: Config = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testRegex: '.*\\.spec\\.ts$',
  transform: {
    '^.+\\.(t|j)s$': 'ts-jest',
  },
  collectCoverageFrom: ['**/*.(t|j)s'],
  moduleNameMapper: {
    'src/(.*)': '<rootDir>/src/$1',
    '@/(.*)': '<rootDir>/src/$1',
  },
  coverageDirectory: '../coverage',
  testEnvironment: 'node',
  preset: 'ts-jest',
};

export default config;
