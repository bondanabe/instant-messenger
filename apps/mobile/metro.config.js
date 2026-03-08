const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config')
const path = require('path')

const projectRoot = __dirname
const workspaceRoot = path.resolve(projectRoot, '../..')

const config = {
  watchFolders: [workspaceRoot],
  resolver: {
    nodeModulesPaths: [
      path.resolve(projectRoot, 'node_modules'),
      path.resolve(workspaceRoot, 'node_modules'),
    ],
    // Pastikan workspace packages di-resolve dengan benar
    extraNodeModules: {
      '@im/core': path.resolve(workspaceRoot, 'packages/core/src'),
      '@im/db-schema': path.resolve(workspaceRoot, 'packages/db-schema/src'),
    },
  },
}

module.exports = mergeConfig(getDefaultConfig(__dirname), config)
