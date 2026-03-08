module.exports = {
  presets: ['@react-native/babel-preset'],
  plugins: [
    [
      'module-resolver',
      {
        root: ['./src'],
        extensions: ['.ios.js', '.android.js', '.js', '.ts', '.tsx', '.json'],
        alias: {
          '@im/core': '../../packages/core/src',
          '@im/db-schema': '../../packages/db-schema/src',
        },
      },
    ],
  ],
}
