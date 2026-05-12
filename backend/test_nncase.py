import nncase
print('nncase imported OK')
opts = nncase.CompileOptions()
opts.target = 'k230'
print('k230 target OK')
compiler = nncase.Compiler(opts)
print('Compiler created OK')