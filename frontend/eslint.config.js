import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactPlugin from 'eslint-plugin-react';
import reactHooksPlugin from 'eslint-plugin-react-hooks';
import prettierPlugin from 'eslint-plugin-prettier';

export default tseslint.config(
  { ignores: ['dist/', 'node_modules/', '*.config.*'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2020,
      globals: {
        browser: true,
        es2020: true,
      },
      parserOptions: {
        ecmaFeatures: {
          jsx: true,
        },
        sourceType: 'module',
      },
    },
    settings: {
      react: {
        version: '18.3',
      },
    },
    plugins: {
      react: reactPlugin,
      'react-hooks': reactHooksPlugin,
      prettier: prettierPlugin,
    },
    rules: {
      ...reactPlugin.configs.recommended.rules,
      ...reactHooksPlugin.configs.recommended.rules,
      'prettier/prettier': 'error',
      'react/react-in-jsx-scope': 'off',
      'react/prop-types': 'off',
      'react/no-unknown-property': ['error', { ignore: ['position', 'args', 'castShadow', 'receiveShadow', 'intensity', 'transparent', 'roughness', 'metalness', 'emissive', 'emissiveIntensity', 'scale', 'onPointerOver', 'onPointerOut', 'onClick', 'ref', 'makeDefault', 'target', 'enablePan', 'enableZoom', 'enableRotate', 'minPolarAngle', 'maxPolarAngle', 'minZoom', 'maxZoom', 'onChange', 'onCreated', 'colorCenterLine', 'colorGrid', 'divisions', 'size', 'floorLevel', 'floorHeight', 'wallThickness', 'buildingWidth', 'buildingDepth', 'isSelected', 'isHovered', 'onHover', 'onLeave', 'raycast', 'depthWrite', 'side', 'toneMapped', 'attach', 'blending', 'geometry', 'visible', 'rotation'] }],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  }
);
