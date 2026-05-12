import sys
import nncase
import numpy as np

def compile_model(onnx_path, kmodel_path):
    with open(onnx_path, 'rb') as f:
        model_content = f.read()

    compile_options = nncase.CompileOptions()
    compile_options.target = 'k230'
    compile_options.dump_ir = False
    compile_options.dump_asm = False

    compiler = nncase.Compiler(compile_options)

    import_options = nncase.ImportOptions()
    compiler.import_onnx(model_content, import_options)

    def calib_gen():
        for _ in range(10):
            yield [np.random.rand(1, 224, 224, 3).astype(np.float32)]

    ptq_options = nncase.PTQTensorOptions()
    ptq_options.samples_count = 10
    ptq_options.set_tensor_data(calib_gen())
    compiler.use_ptq(ptq_options)

    compiler.compile()

    kmodel = compiler.gencode_tobytes()
    with open(kmodel_path, 'wb') as f:
        f.write(kmodel)

    print(f'kmodel saved → {kmodel_path}')

if __name__ == '__main__':
    compile_model(sys.argv[1], sys.argv[2])