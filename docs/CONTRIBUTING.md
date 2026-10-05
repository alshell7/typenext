# Contributing Guidelines

Thank you for your interest in contributing to this Tauri React Template! This document provides guidelines and information for contributors.

## 🚀 Quick Start for Contributors

### Prerequisites

- [Node.js](https://nodejs.org/) (v18+)
- [Rust](https://rustup.rs/) (latest stable)
- [Git](https://git-scm.com/)
- Familiarity with React, TypeScript, and Rust

### Development Setup

```bash
# Fork and clone the repository
git clone https://github.com/your-username/tauri-template.git
cd tauri-template

# Install dependencies
npm install

# Start development server
npm run dev

# Run tests and quality checks
npm run check:all
```

## 📋 How to Contribute

### 1. Issues

- **Bug Reports**: Use the bug report template
- **Feature Requests**: Use the feature request template
- **Questions**: Use GitHub Discussions for questions
- **Security Issues**: See [SECURITY.md](SECURITY.md)

### 2. Pull Requests

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/amazing-feature`
3. Make your changes following our guidelines
4. Ensure all quality checks pass: `npm run check:all`
5. Commit using conventional commits (see below)
6. Push to your fork: `git push origin feature/amazing-feature`
7. Open a Pull Request

## 📝 Development Guidelines

### Code Style

#### TypeScript/React

- Use TypeScript for all new code
- Follow existing component patterns
- Use functional components with hooks
- Prefer composition over inheritance
- Use meaningful variable and function names

```typescript
// ✅ Good
const UserProfile = ({ userId }: { userId: string }) => {
  const { data: user, isLoading } = useUser(userId)

  if (isLoading) return <LoadingSpinner />
  return <div>{user?.name}</div>
}

// ❌ Avoid
const UP = (props: any) => {
  const d = useUser(props.id)
  return d.loading ? <div>Loading...</div> : <div>{d.data.name}</div>
}
```

#### Rust

- Follow Rust conventions and idioms
- Use `cargo fmt` and `cargo clippy`
- Write descriptive error messages
- Use `Result<T, String>` for Tauri commands

```rust
// ✅ Good
#[tauri::command]
async fn save_user_data(app: AppHandle, data: UserData) -> Result<(), String> {
    validate_user_data(&data)?;

    let file_path = get_safe_user_data_path(&app)?;
    write_data_atomically(&file_path, &data)
        .map_err(|e| format!("Failed to save user data: {e}"))
}

// ❌ Avoid
#[tauri::command]
fn save(app: AppHandle, d: Value) -> Result<(), String> {
    let p = app.path().app_data_dir().unwrap().join("data.json");
    std::fs::write(p, serde_json::to_string(&d).unwrap()).unwrap();
    Ok(())
}
```

### Architecture Guidelines

#### State Management

Follow the State Management Onion pattern:

- **useState**: Component-local state
- **Zustand**: App-wide UI state
- **TanStack Query**: Server state and caching

#### Performance

- Use `getState()` pattern to avoid render cascades
- Implement proper memoization where needed
- Optimize bundle size and load times

#### File Organization

```
src/
├── components/          # Reusable UI components
│   ├── ui/             # Base UI components (shadcn/ui)
│   └── feature/        # Feature-specific components
├── hooks/              # Custom React hooks
├── lib/                # Utility functions and configurations
├── services/           # External API integrations
├── store/              # Zustand stores
└── types/              # TypeScript type definitions
```

## 🧪 Testing Requirements

All contributions must include appropriate tests:

### Frontend Testing

```typescript
// Component tests
import { render, screen } from '@testing-library/react'
import { UserProfile } from './UserProfile'

test('renders user profile with loading state', () => {
  render(<UserProfile userId="123" />)
  expect(screen.getByText('Loading...')).toBeInTheDocument()
})
```

### Backend Testing

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_validate_user_data() {
        let valid_data = UserData { name: "John".to_string() };
        assert!(validate_user_data(&valid_data).is_ok());

        let invalid_data = UserData { name: "".to_string() };
        assert!(validate_user_data(&invalid_data).is_err());
    }
}
```

### Quality Gates

All PRs must pass:

- ✅ TypeScript type checking
- ✅ ESLint linting
- ✅ Prettier formatting
- ✅ React component tests
- ✅ Rust formatting and clippy
- ✅ Rust unit tests

Run locally: `npm run check:all`

## 📦 Commit Guidelines

We use [Conventional Commits](https://www.conventionalcommits.org/):

```bash
# Format: <type>[optional scope]: <description>

# Examples:
git commit -m "feat: add user authentication system"
git commit -m "fix(ui): resolve sidebar toggle issue"
git commit -m "docs: update installation instructions"
git commit -m "refactor(store): simplify user state management"
git commit -m "test: add unit tests for preferences service"
```

### Commit Types

- `feat`: New features
- `fix`: Bug fixes
- `docs`: Documentation changes
- `style`: Code style changes (formatting, etc.)
- `refactor`: Code refactoring
- `test`: Adding or updating tests
- `chore`: Maintenance tasks

## 🎯 Areas for Contribution

### High Priority

- **Performance optimizations**
- **Security improvements**
- **Cross-platform compatibility**
- **Accessibility enhancements**
- **Documentation improvements**

### Medium Priority

- **UI/UX improvements**
- **Additional Tauri plugins integration**
- **Testing coverage expansion**
- **Developer experience enhancements**

### Ideas for New Contributors

- **Fix typos and improve documentation**
- **Add missing TypeScript types**
- **Improve error messages**
- **Add unit tests for untested code**
- **Update dependencies**

## 🔍 Code Review Process

### For Contributors

- Keep PRs focused and reasonably sized
- Write clear PR descriptions
- Respond to feedback promptly
- Update documentation as needed

### Review Criteria

- **Functionality**: Does the code work as intended?
- **Security**: Are there any security implications?
- **Performance**: Does it impact app performance?
- **Maintainability**: Is the code readable and well-structured?
- **Testing**: Are there adequate tests?
- **Documentation**: Is documentation updated?

## 📚 Documentation

### Code Documentation

- Add JSDoc comments for complex functions
- Document public APIs thoroughly
- Include usage examples where helpful

```typescript
/**
 * Validates user input and returns sanitized data
 * @param input - Raw user input string
 * @param maxLength - Maximum allowed length
 * @returns Sanitized string safe for use
 * @example
 * const safe = sanitizeInput("<script>alert('hi')</script>", 100)
 * // Returns: "alert('hi')"
 */
export function sanitizeInput(input: string, maxLength: number): string {
  return input.replace(/[<>]/g, '').slice(0, maxLength).trim()
}
```

### Architecture Documentation

When adding new patterns or systems:

- Update `docs/developer/architecture-guide.md`
- Add examples to relevant documentation
- Consider creating new guide documents for complex features

## 🌟 Recognition

Contributors will be recognized in:

- **README.md**: Major contributors listed
- **Release Notes**: Contributions acknowledged
- **GitHub**: Contributor badge and statistics

## 🆘 Getting Help

### Community Support

- **GitHub Discussions**: Ask questions and share ideas
- **Issues**: Report bugs and request features
- **Discord/Slack**: [Add your community links if available]

### Maintainer Contact

- **Project Lead**: [Your contact information]
- **Technical Questions**: Create a GitHub issue
- **Security Issues**: See [SECURITY.md](SECURITY.md)

## 📄 Legal

By contributing to this project, you agree that:

- TypeNext-owned contributions use the project's MIT license. Retain the original license and attribution of any third-party material you introduce.
- You have the right to contribute the code/content
- Your contributions are your original work or properly attributed

## 🎉 Thank You!

Every contribution, no matter how small, helps make this template better for everyone. Thank you for taking the time to contribute!

---

**Questions?** Feel free to open an issue or reach out to the maintainers. We're here to help make your contribution experience as smooth as possible.
