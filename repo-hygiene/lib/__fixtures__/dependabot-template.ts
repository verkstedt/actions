export const DEPENDABOT_TEMPLATE = `# Org template
version: 2
updates:
  # JavaScript
  - package-ecosystem: 'npm'
    directory: '/'
    schedule:
      interval: 'weekly'
    cooldown:
      default-days: 7
  - package-ecosystem: 'docker'
    directory: '/'
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
`
