import React, { useState, useRef, useEffect } from 'react';
import {
    View, Text, TouchableOpacity, StyleSheet,
    ScrollView, Alert, Image, Platform,
    ActivityIndicator, TextInput
} from 'react-native';

const CONVERT_SERVER = 'https://wesley-plays-seasonal-third.trycloudflare.com';

function sendClassesToBlockly(classes) {
    const payload = JSON.stringify({ type: 'AI_MODEL_TRAINED', classes });
    if (Platform.OS === 'web') {
        window.parent?.postMessage(payload, '*');
        window.postMessage(payload, '*');
    } else if (window.ReactNativeWebView) {
        window.ReactNativeWebView.postMessage(payload);
    }
}

let tmModel = null;

export default function TrainDeployScreen({ onBack }) {
    const [classes, setClasses] = useState([
        { id: 1, name: 'Class1', images: [], color: '#f54254' },
        { id: 2, name: 'Class2', images: [], color: '#7c3aed' },
    ]);
    const [trained, setTrained] = useState(false);
    const [training, setTraining] = useState(false);
    const [exporting, setExporting] = useState(false);
    const [trainProgress, setTrainProgress] = useState(0);
    const [statusMsg, setStatusMsg] = useState('');
    const [liveResult, setLiveResult] = useState(null);
    const [activeClassIdx, setActiveClassIdx] = useState(null);
    const [testWebcamActive, setTestWebcamActive] = useState(false);

    const captureVideoId = 'capture-video-el';
    const testVideoId = 'test-video-el';
    const captureInterval = useRef(null);
    const testInterval = useRef(null);
    const nextId = useRef(3);

    const classColors = [
        '#f54254', '#7c3aed', '#0ea5e9',
        '#10b981', '#f59e0b', '#ec4899'
    ];

    useEffect(() => {
        return () => {
            stopCapture();
            stopTestWebcam();
        };
    }, []);

    // ── helpers to get video DOM elements directly ──────────────────────
    const getCaptureVideo = () => document.getElementById(captureVideoId);
    const getTestVideo = () => document.getElementById(testVideoId);

    // ── File upload ──────────────────────────────────────────────────────
    const handleUpload = (classIdx) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/*';
        input.multiple = true;
        input.onchange = (e) => {
            Array.from(e.target.files).forEach(file => {
                const url = URL.createObjectURL(file);
                setClasses(prev => prev.map((c, i) =>
                    i === classIdx
                        ? { ...c, images: [...c.images, { url }] }
                        : c
                ));
            });
        };
        input.click();
    };

    // ── Start webcam for a class ─────────────────────────────────────────
    const startCapture = async (classIdx) => {
        try {
            // stop any existing stream first
            stopCapture();

            const stream = await navigator.mediaDevices.getUserMedia({
                video: { width: 224, height: 224, facingMode: 'user' }
            });

            // Small delay so React renders the video element first
            await new Promise(r => setTimeout(r, 100));

            const video = getCaptureVideo();
            if (!video) {
                Alert.alert('Error', 'Video element not found');
                return;
            }

            video.srcObject = stream;
            video.onloadedmetadata = () => video.play();

            setActiveClassIdx(classIdx);

        } catch (e) {
            Alert.alert('Camera Error', e.message);
        }
    };

    // ── Capture a single frame ───────────────────────────────────────────
    const captureFrame = (classIdx) => {
        const video = getCaptureVideo();
        if (!video || video.readyState < 2) return;

        const canvas = document.createElement('canvas');
        canvas.width = 224;
        canvas.height = 224;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(video, 0, 0, 224, 224);

        // Skip black frames
        const px = ctx.getImageData(0, 0, 8, 8).data;
        if (px.every(v => v < 15)) return;

        const url = canvas.toDataURL('image/jpeg', 0.8);
        setClasses(prev => prev.map((c, i) =>
            i === classIdx
                ? { ...c, images: [...c.images, { url }] }
                : c
        ));
    };

    const holdCapture = (classIdx) => {
        captureFrame(classIdx);
        captureInterval.current = setInterval(
            () => captureFrame(classIdx), 120
        );
    };

    const releaseCapture = () => {
        clearInterval(captureInterval.current);
    };

    const stopCapture = () => {
        clearInterval(captureInterval.current);
        const video = getCaptureVideo();
        if (video?.srcObject) {
            video.srcObject.getTracks().forEach(t => t.stop());
            video.srcObject = null;
        }
        setActiveClassIdx(null);
    };

    // ── Train model ──────────────────────────────────────────────────────
    const trainModel = async () => {
        const valid = classes.filter(c => c.images.length >= 2);
        if (valid.length < 2) {
            Alert.alert('Not enough data', 'Add at least 2 images to each class');
            return;
        }

        setTraining(true);
        setTrainProgress(0);
        setTrained(false);
        setStatusMsg('Loading TensorFlow...');
        tmModel = null;

        try {
            const tf = await import('@tensorflow/tfjs');

            setStatusMsg('Loading MobileNet...');
            const mobilenet = await tf.loadLayersModel(
                'https://storage.googleapis.com/tfjs-models/tfjs/mobilenet_v1_0.25_224/model.json'
            );

            const layer = mobilenet.getLayer('conv_pw_13_relu');
            const truncated = tf.model({
                inputs: mobilenet.inputs,
                outputs: layer.output
            });

            setStatusMsg('Extracting features...');

            const xs = [];
            const ys = [];
            let done = 0;
            const total = classes.reduce((s, c) => s + c.images.length, 0);

            for (let ci = 0; ci < classes.length; ci++) {
                for (const img of classes[ci].images) {
                    await new Promise((resolve) => {
                        const el = new window.Image();
                        el.crossOrigin = 'anonymous';
                        el.onload = () => {
                            try {
                                const tensor = tf.tidy(() =>
                                    tf.browser.fromPixels(el)
                                        .resizeBilinear([224, 224])
                                        .toFloat().div(127.5).sub(1)
                                        .expandDims(0)
                                );
                                const feat = tf.tidy(() =>
                                    truncated.predict(tensor).flatten()
                                );
                                xs.push(feat);
                                ys.push(ci);
                                tensor.dispose();
                            } catch (err) {
                                console.warn('Feature error:', err);
                            }
                            done++;
                            setTrainProgress(Math.round((done / total) * 50));
                            resolve();
                        };
                        el.onerror = () => { done++; resolve(); };
                        el.src = img.url;
                    });
                }
            }

            if (xs.length === 0) throw new Error('No features extracted');

            const featureSize = xs[0].shape[0];
            const numClasses = classes.length;

            const xsTensor = tf.stack(xs);
            const ysTensor = tf.oneHot(tf.tensor1d(ys, 'int32'), numClasses);
            xs.forEach(x => x.dispose());

            const head = tf.sequential({
                layers: [
                    tf.layers.dense({
                        inputShape: [featureSize],
                        units: 100,
                        activation: 'relu'
                    }),
                    tf.layers.dense({
                        units: numClasses,
                        activation: 'softmax'
                    })
                ]
            });

            head.compile({
                optimizer: tf.train.adam(0.001),
                loss: 'categoricalCrossentropy',
                metrics: ['accuracy']
            });

            setStatusMsg('Training...');

            await head.fit(xsTensor, ysTensor, {
                epochs: 100,
                batchSize: 16,
                callbacks: {
                    onEpochEnd: (epoch) => {
                        setTrainProgress(50 + Math.round(((epoch + 1) / 50) * 50));
                        setStatusMsg(`Epoch ${epoch + 1} / 50`);
                    }
                }
            });

            xsTensor.dispose();
            ysTensor.dispose();

            const classNamesCopy = classes.map(c => c.name);

            tmModel = {
                truncated,
                head,
                classNames: classNamesCopy,
                predict: (videoEl) => {
                    return tf.tidy(() => {
                        const tensor = tf.browser.fromPixels(videoEl)
                            .resizeBilinear([224, 224])
                            .toFloat().div(127.5).sub(1)
                            .expandDims(0);
                        const feat = truncated.predict(tensor).flatten().expandDims(0);
                        const probs = head.predict(feat).dataSync();
                        return classNamesCopy.map((name, i) => ({
                            className: name,
                            probability: probs[i]
                        }));
                    });
                }
            };

            setTrained(true);
            setTrainProgress(100);
            setStatusMsg('Training complete!');

        } catch (e) {
            console.error('Training error:', e);
            Alert.alert('Training Failed', e.message);
            setStatusMsg('Failed: ' + e.message);
        } finally {
            setTraining(false);
        }
    };

    // ── Test webcam ──────────────────────────────────────────────────────
    const startTestWebcam = async () => {
        if (!trained || !tmModel) {
            Alert.alert('Train first!');
            return;
        }
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                video: { width: 224, height: 224 }
            });

            await new Promise(r => setTimeout(r, 100));

            const video = getTestVideo();
            if (!video) return;

            video.srcObject = stream;
            video.onloadedmetadata = () => video.play();
            setTestWebcamActive(true);

            testInterval.current = setInterval(() => {
                const v = getTestVideo();
                if (!v || v.readyState < 2 || !tmModel) return;
                try {
                    const predictions = tmModel.predict(v);
                    const best = predictions.reduce((a, b) =>
                        a.probability > b.probability ? a : b
                    );
                    const probs = {};
                    predictions.forEach(p => {
                        probs[p.className] = Math.round(p.probability * 100);
                    });
                    setLiveResult({ label: best.className, probabilities: probs });
                } catch (err) {
                    console.warn('Predict error:', err);
                }
            }, 300);

        } catch (e) {
            Alert.alert('Camera Error', e.message);
        }
    };

    const stopTestWebcam = () => {
        clearInterval(testInterval.current);
        const video = getTestVideo();
        if (video?.srcObject) {
            video.srcObject.getTracks().forEach(t => t.stop());
            video.srcObject = null;
        }
        setTestWebcamActive(false);
        setLiveResult(null);
    };

    // ── Deploy to Blockly ────────────────────────────────────────────────
    const deployToBlockly = () => {
        if (!trained) { Alert.alert('Train first!'); return; }
        const classNames = classes.filter(c => c.images.length > 0).map(c => c.name);
        sendClassesToBlockly(classNames);
        Alert.alert(
            'Deployed!',
            `AI blocks for ${classNames.join(', ')} added.`,
            [{ text: 'Go to Workspace', onPress: onBack }]
        );
    };

    // ── Export .kmodel ───────────────────────────────────────────────────
    const exportKmodel = async () => {
        if (!trained || !tmModel) { Alert.alert('Train first!'); return; }

        setExporting(true);
        setStatusMsg('Exporting model...');

        try {
            const tf = await import('@tensorflow/tfjs');
            let savedArtifacts = null;

            await tmModel.head.save(
                tf.io.withSaveHandler(async (artifacts) => {
                    savedArtifacts = artifacts;
                    return { modelArtifactsInfo: { dateSaved: new Date() } };
                })
            );

            if (!savedArtifacts) throw new Error('Failed to capture model artifacts');

            const formData = new FormData();
            formData.append(
                'model_json',
                new Blob([JSON.stringify(savedArtifacts.modelTopology)],
                    { type: 'application/json' }),
                'model.json'
            );
            formData.append(
                'weights_bin',
                new Blob([savedArtifacts.weightData],
                    { type: 'application/octet-stream' }),
                'weights.bin'
            );
            formData.append('labels', JSON.stringify(classes.map(c => c.name)));

            setStatusMsg('Sending to server...');

            const resp = await fetch(`${CONVERT_SERVER}/convert`, {
                method: 'POST',
                body: formData,
            });

            if (!resp.ok) {
                const err = await resp.json();
                throw new Error(err.error || 'Server error');
            }

            setStatusMsg('Downloading .kmodel...');
            const blob = await resp.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'model.kmodel';
            a.click();
            URL.revokeObjectURL(url);

            setStatusMsg('model.kmodel downloaded!');
            Alert.alert('Success', 'Copy model.kmodel to your K230 device.');

        } catch (e) {
            console.error('Export error:', e);
            Alert.alert('Export Failed', e.message);
            setStatusMsg('Export failed: ' + e.message);
        } finally {
            setExporting(false);
        }
    };

    // ── Add / remove class ───────────────────────────────────────────────
    const addClass = () => {
        const id = nextId.current++;
        setClasses(prev => [...prev, {
            id, name: `Class${id}`, images: [],
            color: classColors[(id - 1) % classColors.length]
        }]);
    };

    const removeClass = (idx) => {
        if (classes.length <= 2) { Alert.alert('Need at least 2 classes'); return; }
        setClasses(prev => prev.filter((_, i) => i !== idx));
    };

    const removeImage = (classIdx, imgIdx) => {
        setClasses(prev => prev.map((c, i) =>
            i === classIdx
                ? { ...c, images: c.images.filter((_, j) => j !== imgIdx) }
                : c
        ));
    };

    // ════════════════════════════════════════════════════════════════════
    // RENDER
    // ════════════════════════════════════════════════════════════════════
    return (
        <View style={s.root}>

            <View style={s.header}>
                <TouchableOpacity onPress={onBack} style={s.backBtn}>
                    <Text style={s.backTxt}>← Workspace</Text>
                </TouchableOpacity>
                <Text style={s.title}>Model Training</Text>
                <TouchableOpacity
                    onPress={deployToBlockly}
                    style={[s.deployBtn, !trained && s.disabledBtn]}
                >
                    <Text style={s.deployTxt}>Deploy to Blocks →</Text>
                </TouchableOpacity>
            </View>

            {statusMsg !== '' && (
                <View style={s.statusBar}>
                    <Text style={s.statusTxt}>{statusMsg}</Text>
                </View>
            )}

            <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                style={s.columns}
                contentContainerStyle={s.columnsContent}
            >
                {/* ── Column 1 ── */}
                <View style={s.col}>
                    <Text style={s.colTitle}>1. Collect Images</Text>
                    <ScrollView style={s.classScroll} showsVerticalScrollIndicator={false}>
                        {classes.map((cls, classIdx) => (
                            <View
                                key={cls.id}
                                style={[s.classCard, { borderLeftColor: cls.color, borderLeftWidth: 4 }]}
                            >
                                <View style={s.classCardHeader}>
                                    <TextInput
                                        style={[s.classNameInput, { color: cls.color }]}
                                        value={cls.name}
                                        onChangeText={txt =>
                                            setClasses(prev => prev.map((c, i) =>
                                                i === classIdx ? { ...c, name: txt } : c
                                            ))
                                        }
                                    />
                                    <Text style={s.sampleCount}>{cls.images.length} samples</Text>
                                    <TouchableOpacity onPress={() => removeClass(classIdx)} style={s.removeBtn}>
                                        <Text style={s.removeTxt}>✕</Text>
                                    </TouchableOpacity>
                                </View>

                                {/* ── video element always in DOM, shown only when active ── */}
                                {activeClassIdx === classIdx ? (
                                    <View style={s.camArea}>
                                        <video
                                            id={captureVideoId}
                                            autoPlay
                                            playsInline
                                            muted
                                            style={{
                                                width: '100%',
                                                height: 160,
                                                objectFit: 'cover',
                                                borderRadius: 8,
                                                backgroundColor: '#000',
                                                display: 'block',
                                            }}
                                        />
                                        <View style={s.camBtns}>
                                            <TouchableOpacity
                                                onMouseDown={() => holdCapture(classIdx)}
                                                onMouseUp={releaseCapture}
                                                onTouchStart={() => holdCapture(classIdx)}
                                                onTouchEnd={releaseCapture}
                                                style={[s.holdBtn, { backgroundColor: cls.color }]}
                                            >
                                                <Text style={s.holdTxt}>Hold to Capture</Text>
                                            </TouchableOpacity>
                                            <TouchableOpacity onPress={stopCapture} style={s.stopCamBtn}>
                                                <Text style={s.stopCamTxt}>Stop</Text>
                                            </TouchableOpacity>
                                        </View>
                                    </View>
                                ) : (
                                    <View style={s.addBtns}>
                                        <TouchableOpacity
                                            onPress={() => startCapture(classIdx)}
                                            style={[s.addBtn, {
                                                backgroundColor: cls.color + '22',
                                                borderColor: cls.color
                                            }]}
                                        >
                                            <Text style={[s.addBtnTxt, { color: cls.color }]}>
                                                Webcam
                                            </Text>
                                        </TouchableOpacity>
                                        <TouchableOpacity
                                            onPress={() => handleUpload(classIdx)}
                                            style={[s.addBtn, {
                                                backgroundColor: cls.color + '22',
                                                borderColor: cls.color
                                            }]}
                                        >
                                            <Text style={[s.addBtnTxt, { color: cls.color }]}>
                                                Upload
                                            </Text>
                                        </TouchableOpacity>
                                    </View>
                                )}

                                {cls.images.length > 0 && (
                                    <ScrollView horizontal style={s.thumbRow} showsHorizontalScrollIndicator={false}>
                                        {cls.images.map((img, imgIdx) => (
                                            <TouchableOpacity
                                                key={imgIdx}
                                                onPress={() => removeImage(classIdx, imgIdx)}
                                                style={s.thumbWrap}
                                            >
                                                <Image source={{ uri: img.url }} style={s.thumb} />
                                                <View style={s.thumbX}>
                                                    <Text style={s.thumbXTxt}>✕</Text>
                                                </View>
                                            </TouchableOpacity>
                                        ))}
                                    </ScrollView>
                                )}
                            </View>
                        ))}

                        <TouchableOpacity onPress={addClass} style={s.addClassBtn}>
                            <Text style={s.addClassTxt}>+ Add a Class</Text>
                        </TouchableOpacity>
                    </ScrollView>
                </View>

                <View style={s.arrow}><Text style={s.arrowTxt}>→</Text></View>

                {/* ── Column 2 ── */}
                <View style={s.col}>
                    <Text style={s.colTitle}>2. Train Model</Text>
                    <View style={s.trainCard}>
                        {training ? (
                            <View style={s.trainProgress}>
                                <ActivityIndicator size="large" color="#f54254" />
                                <Text style={s.progressPct}>{trainProgress}%</Text>
                                <View style={s.progressBar}>
                                    <View style={[s.progressFill, { width: `${trainProgress}%` }]} />
                                </View>
                                <Text style={s.progressLabel}>{statusMsg}</Text>
                            </View>
                        ) : trained ? (
                            <View style={s.trainDone}>
                                <Text style={s.trainDoneIcon}>✅</Text>
                                <Text style={s.trainDoneTitle}>Model Trained!</Text>
                                <Text style={s.trainDoneDesc}>
                                    {classes.reduce((s, c) => s + c.images.length, 0)} images · {classes.length} classes
                                </Text>
                                <TouchableOpacity onPress={trainModel} style={s.retrainBtn}>
                                    <Text style={s.retrainTxt}>Retrain</Text>
                                </TouchableOpacity>
                            </View>
                        ) : (
                            <View style={s.trainReady}>
                                <Text style={s.trainReadyIcon}>🧠</Text>
                                <Text style={s.trainReadyTitle}>Ready to train.</Text>
                                <Text style={s.trainReadyDesc}>
                                    Add at least 2 images per class then press Train.
                                </Text>
                            </View>
                        )}

                        <TouchableOpacity
                            onPress={trainModel}
                            disabled={training}
                            style={[s.trainBtn, training && s.disabledBtn]}
                        >
                            <Text style={s.trainBtnTxt}>
                                {training ? 'Training...' : 'Train Model'}
                            </Text>
                        </TouchableOpacity>

                        <View style={s.statsGrid}>
                            {classes.map((cls, i) => (
                                <View key={i} style={s.statRow}>
                                    <View style={[s.statDot, { backgroundColor: cls.color }]} />
                                    <Text style={s.statName}>{cls.name}</Text>
                                    <Text style={s.statCount}>{cls.images.length}</Text>
                                </View>
                            ))}
                        </View>
                    </View>
                </View>

                <View style={s.arrow}><Text style={s.arrowTxt}>→</Text></View>

                {/* ── Column 3 ── */}
                <View style={s.col}>
                    <Text style={s.colTitle}>3. Preview & Deploy</Text>
                    <View style={s.testCard}>

                        {testWebcamActive ? (
                            <View style={s.testWebcamArea}>
                                <video
                                    id={testVideoId}
                                    autoPlay
                                    playsInline
                                    muted
                                    style={{
                                        width: '100%',
                                        height: 160,
                                        objectFit: 'cover',
                                        borderRadius: 8,
                                        backgroundColor: '#000',
                                        display: 'block',
                                    }}
                                />
                                <TouchableOpacity onPress={stopTestWebcam} style={s.stopTestBtn}>
                                    <Text style={s.stopTestTxt}>Stop</Text>
                                </TouchableOpacity>
                            </View>
                        ) : (
                            <View style={s.testWebcamArea}>
                                <TouchableOpacity
                                    onPress={startTestWebcam}
                                    style={[s.testStartBtn, !trained && s.disabledBtn]}
                                >
                                    <Text style={s.testStartTxt}>Test with Webcam</Text>
                                </TouchableOpacity>
                            </View>
                        )}

                        {liveResult && (
                            <View style={s.resultsBox}>
                                <Text style={s.resultsTitle}>
                                    Prediction:{' '}
                                    <Text style={s.resultsBest}>{liveResult.label}</Text>
                                </Text>
                                {Object.entries(liveResult.probabilities).map(([label, pct], i) => {
                                    const cls = classes.find(c => c.name === label);
                                    const color = cls?.color || classColors[i % classColors.length];
                                    return (
                                        <View key={label} style={s.resultRow}>
                                            <Text style={s.resultLabel}>{label}</Text>
                                            <View style={s.resultBarBg}>
                                                <View style={[s.resultBarFill, {
                                                    width: `${pct}%`,
                                                    backgroundColor: color
                                                }]} />
                                            </View>
                                            <Text style={s.resultPct}>{pct}%</Text>
                                        </View>
                                    );
                                })}
                            </View>
                        )}

                        <TouchableOpacity
                            onPress={deployToBlockly}
                            style={[s.deployCardBtn, !trained && s.disabledBtn]}
                        >
                            <Text style={s.deployCardBtnTxt}>Deploy to Blockly</Text>
                        </TouchableOpacity>

                        <TouchableOpacity
                            onPress={exportKmodel}
                            disabled={exporting || !trained}
                            style={[s.exportBtn, (!trained || exporting) && s.disabledBtn]}
                        >
                            {exporting
                                ? <ActivityIndicator size="small" color="#fff" />
                                : <Text style={s.exportBtnTxt}>Export .kmodel for K230</Text>
                            }
                        </TouchableOpacity>

                        <Text style={s.deployHint}>
                            Deploy adds AI blocks to workspace.{'\n'}
                            Export converts and downloads for K230.
                        </Text>
                    </View>
                </View>

            </ScrollView>
        </View>
    );
}

const s = StyleSheet.create({
    root: { flex: 1, backgroundColor: '#f8fafc' },
    header: {
        flexDirection: 'row', alignItems: 'center',
        justifyContent: 'space-between',
        backgroundColor: '#fff', paddingHorizontal: 20,
        paddingVertical: 14, borderBottomWidth: 1,
        borderBottomColor: '#e2e8f0', elevation: 3,
    },
    backBtn: { padding: 8, borderRadius: 8, backgroundColor: '#f1f5f9' },
    backTxt: { fontSize: 14, fontWeight: '600', color: '#475569' },
    title: { fontSize: 18, fontWeight: '700', color: '#1e293b' },
    deployBtn: {
        backgroundColor: '#f54254',
        paddingHorizontal: 16, paddingVertical: 8, borderRadius: 8
    },
    deployTxt: { color: '#fff', fontWeight: '700', fontSize: 14 },
    disabledBtn: { opacity: 0.4 },
    statusBar: { backgroundColor: '#f1f5f9', paddingHorizontal: 20, paddingVertical: 8 },
    statusTxt: { fontSize: 13, color: '#475569' },
    columns: { flex: 1 },
    columnsContent: { flexDirection: 'row', padding: 16, gap: 12, alignItems: 'flex-start' },
    col: { width: 340, minHeight: 400 },
    colTitle: { fontSize: 15, fontWeight: '700', color: '#374151', marginBottom: 12 },
    arrow: { justifyContent: 'center', alignItems: 'center', paddingTop: 160, paddingHorizontal: 4 },
    arrowTxt: { fontSize: 28, color: '#cbd5e1' },
    classScroll: { maxHeight: 620 },
    classCard: {
        backgroundColor: '#fff', borderRadius: 12,
        padding: 14, marginBottom: 12, elevation: 2,
    },
    classCardHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 10 },
    classNameInput: {
        flex: 1, fontSize: 15, fontWeight: '700',
        borderBottomWidth: 1.5, borderBottomColor: '#e2e8f0', paddingBottom: 2,
    },
    sampleCount: { fontSize: 12, color: '#94a3b8', marginHorizontal: 8 },
    removeBtn: { padding: 4 },
    removeTxt: { fontSize: 14, color: '#94a3b8' },
    camArea: { marginBottom: 8 },
    camBtns: { flexDirection: 'row', gap: 8, marginTop: 8 },
    holdBtn: { flex: 1, paddingVertical: 12, borderRadius: 8, alignItems: 'center' },
    holdTxt: { color: '#fff', fontWeight: '700', fontSize: 13 },
    stopCamBtn: {
        paddingVertical: 12, paddingHorizontal: 16,
        borderRadius: 8, backgroundColor: '#f1f5f9'
    },
    stopCamTxt: { color: '#64748b', fontWeight: '600' },
    addBtns: { flexDirection: 'row', gap: 8, marginBottom: 4 },
    addBtn: {
        flex: 1, alignItems: 'center', justifyContent: 'center',
        paddingVertical: 12, borderRadius: 8, borderWidth: 1.5,
    },
    addBtnTxt: { fontWeight: '600', fontSize: 13 },
    thumbRow: { marginTop: 8 },
    thumbWrap: { position: 'relative', marginRight: 6 },
    thumb: { width: 56, height: 56, borderRadius: 6 },
    thumbX: {
        position: 'absolute', top: -4, right: -4,
        width: 16, height: 16, borderRadius: 8,
        backgroundColor: '#ef4444', alignItems: 'center', justifyContent: 'center',
    },
    thumbXTxt: { color: '#fff', fontSize: 9, fontWeight: '700' },
    addClassBtn: {
        borderWidth: 2, borderColor: '#e2e8f0', borderStyle: 'dashed',
        borderRadius: 10, paddingVertical: 14, alignItems: 'center', marginTop: 4,
    },
    addClassTxt: { color: '#94a3b8', fontWeight: '600', fontSize: 14 },
    trainCard: { backgroundColor: '#fff', borderRadius: 12, padding: 20, elevation: 2 },
    trainProgress: { alignItems: 'center', paddingVertical: 20, gap: 10 },
    progressPct: { fontSize: 32, fontWeight: '800', color: '#f54254' },
    progressBar: {
        width: '100%', height: 6,
        backgroundColor: '#f1f5f9', borderRadius: 3, overflow: 'hidden'
    },
    progressFill: { height: '100%', backgroundColor: '#f54254', borderRadius: 3 },
    progressLabel: { fontSize: 13, color: '#94a3b8', textAlign: 'center' },
    trainDone: { alignItems: 'center', paddingVertical: 16, gap: 6 },
    trainDoneIcon: { fontSize: 36 },
    trainDoneTitle: { fontSize: 17, fontWeight: '700', color: '#10b981' },
    trainDoneDesc: { fontSize: 13, color: '#94a3b8' },
    retrainBtn: {
        paddingHorizontal: 16, paddingVertical: 6,
        backgroundColor: '#f1f5f9', borderRadius: 6, marginTop: 4
    },
    retrainTxt: { color: '#64748b', fontWeight: '600', fontSize: 13 },
    trainReady: { alignItems: 'center', paddingVertical: 16, gap: 6 },
    trainReadyIcon: { fontSize: 36 },
    trainReadyTitle: { fontSize: 15, fontWeight: '600', color: '#374151' },
    trainReadyDesc: { fontSize: 12, color: '#94a3b8', textAlign: 'center' },
    trainBtn: {
        backgroundColor: '#f54254', borderRadius: 10,
        paddingVertical: 14, alignItems: 'center', marginTop: 16,
    },
    trainBtnTxt: { color: '#fff', fontWeight: '800', fontSize: 16 },
    statsGrid: { marginTop: 16, gap: 8 },
    statRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    statDot: { width: 10, height: 10, borderRadius: 5 },
    statName: { flex: 1, fontSize: 13, color: '#374151', fontWeight: '500' },
    statCount: { fontSize: 13, color: '#94a3b8', fontWeight: '600' },
    testCard: { backgroundColor: '#fff', borderRadius: 12, padding: 20, elevation: 2 },
    testWebcamArea: { marginBottom: 12 },
    stopTestBtn: {
        marginTop: 8, padding: 8,
        backgroundColor: '#f1f5f9', borderRadius: 6, alignItems: 'center'
    },
    stopTestTxt: { color: '#64748b', fontWeight: '600' },
    testStartBtn: {
        backgroundColor: '#0ea5e9', borderRadius: 10,
        paddingVertical: 14, alignItems: 'center'
    },
    testStartTxt: { color: '#fff', fontWeight: '700', fontSize: 14 },
    resultsBox: { marginBottom: 16 },
    resultsTitle: { fontSize: 14, fontWeight: '600', color: '#374151', marginBottom: 10 },
    resultsBest: { color: '#f54254' },
    resultRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 },
    resultLabel: { width: 60, fontSize: 12, color: '#374151', fontWeight: '500' },
    resultBarBg: { flex: 1, height: 8, backgroundColor: '#f1f5f9', borderRadius: 4, overflow: 'hidden' },
    resultBarFill: { height: '100%', borderRadius: 4 },
    resultPct: { width: 32, fontSize: 12, color: '#94a3b8', textAlign: 'right' },
    deployCardBtn: {
        backgroundColor: '#7c3aed', borderRadius: 10,
        paddingVertical: 14, alignItems: 'center', marginTop: 8,
    },
    deployCardBtnTxt: { color: '#fff', fontWeight: '800', fontSize: 15 },
    exportBtn: {
        backgroundColor: '#0ea5e9', borderRadius: 10,
        paddingVertical: 14, alignItems: 'center', marginTop: 8,
    },
    exportBtnTxt: { color: '#fff', fontWeight: '800', fontSize: 15 },
    deployHint: { fontSize: 12, color: '#94a3b8', textAlign: 'center', marginTop: 10, lineHeight: 18 },
});