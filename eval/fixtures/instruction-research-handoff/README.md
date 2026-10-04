# Isolated instruction research fixture

This small project gives plan and report providers a real, disposable codebase
to inspect. It contains no case answers, evaluation rubrics, or provider
credentials. The CLI entry point resolves a setting before passing a request
through a small adapter boundary, and the test observes that handoff.

The project has a settings module, a CLI entry point, and a unit test. Providers
must use the task and the repository evidence to decide what to investigate;
the fixture does not prescribe an implementation method.
