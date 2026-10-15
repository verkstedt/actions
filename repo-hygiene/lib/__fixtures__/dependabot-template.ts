export const DEPENDABOT_TEMPLATE = `# Org template
version: 2
updates:
  # JavaScript
  - package-ecosystem: 'npm'
    directories:
      - '/**'
    exclude-paths: []
    schedule:
      interval: 'weekly'
    cooldown:
      default-days: 7
  - package-ecosystem: 'docker'
    directories:
      - '/**'
    schedule:
      interval: 'weekly'
    cooldown:
      default-days: 7
  - package-ecosystem: 'github-actions'
    directory: '/'
    schedule:
      interval: 'weekly'
    cooldown:
      default-days: 7
`;
